import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "troque-me";
const DB = path.join(__dirname, "data.json");

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); }
  catch { return { orders: [] }; }
}
function writeDb(db) {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}
function basicAuth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="TVPlay Admin"');
    return res.status(401).send("Autenticação necessária.");
  }
  const decoded = Buffer.from(h.slice(6), "base64").toString();
  const i = decoded.indexOf(":");
  if (i < 0 || decoded.slice(0, i) !== ADMIN_USER || decoded.slice(i + 1) !== ADMIN_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="TVPlay Admin"');
    return res.status(401).send("Usuário ou senha inválidos.");
  }
  next();
}

app.get("/api/config", (req, res) => {
  res.json({ price: 30.00, product: "Assinatura TVPlay" });
});

app.post("/api/create-payment", async (req, res) => {
  try {
    if (!ACCESS_TOKEN || ACCESS_TOKEN.includes("COLOQUE_")) {
      return res.status(500).json({ error: "Mercado Pago ainda não configurado no servidor." });
    }
    if (!PUBLIC_URL || !PUBLIC_URL.startsWith("https://")) {
      return res.status(500).json({ error: "PUBLIC_URL precisa ser uma URL HTTPS pública." });
    }

    const { name, whatsapp, email } = req.body;
    if (!name || !whatsapp || !email) {
      return res.status(400).json({ error: "Preencha nome, WhatsApp e e-mail." });
    }

    const externalReference = "TVP-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");

    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify({
        transaction_amount: 30.00,
        description: "Assinatura TVPlay",
        payment_method_id: "pix",
        external_reference: externalReference,
        payer: { email }
      })
    });

    const data = await mpRes.json();
    if (!mpRes.ok) {
      return res.status(mpRes.status).json({ error: "Mercado Pago recusou a criação do pagamento.", details: data });
    }

    const payment = data.point_of_interaction?.transaction_data;
    const db = readDb();
    db.orders.unshift({
      id: externalReference,
      mpPaymentId: String(data.id),
      name, whatsapp, email,
      amount: 30.00,
      status: data.status || "pending",
      createdAt: new Date().toISOString()
    });
    writeDb(db);

    res.json({
      orderId: externalReference,
      status: data.status,
      qrCode: payment?.qr_code || "",
      qrCodeBase64: payment?.qr_code_base64 || "",
      ticketUrl: payment?.ticket_url || ""
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro interno ao criar pagamento." });
  }
});

app.get("/api/status/:orderId", (req, res) => {
  const db = readDb();
  const order = db.orders.find(x => x.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  res.json({ orderId: order.id, status: order.status });
});

app.post("/api/webhook", async (req, res) => {
  // Mercado Pago envia notificações e o servidor consulta a API para confirmar o status real.
  try {
    res.sendStatus(200);
    const type = req.body.type;
    const paymentId = req.body.data?.id;
    if (type !== "payment" || !paymentId || !ACCESS_TOKEN) return;

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` }
    });
    if (!mpRes.ok) return;
    const payment = await mpRes.json();

    const db = readDb();
    const order = db.orders.find(x => x.mpPaymentId === String(payment.id));
    if (!order) return;

    order.status = payment.status || order.status;
    order.updatedAt = new Date().toISOString();
    writeDb(db);
  } catch (e) {
    console.error("Webhook:", e);
  }
});

app.get("/api/admin/orders", basicAuth, (req, res) => {
  res.json(readDb().orders);
});

app.post("/api/admin/orders/:id/activate", basicAuth, (req, res) => {
  const db = readDb();
  const order = db.orders.find(x => x.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  order.status = "activated";
  order.activatedAt = new Date().toISOString();
  writeDb(db);
  res.json({ ok: true });
});

app.get("/admin", basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TVPlay portal rodando na porta ${PORT}`);
});
