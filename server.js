import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const PLANOS = {
  "1": { meses: 1, valor: 30 },
  "2": { meses: 2, valor: 50 },
  "3": { meses: 3, valor: 70 },
  "4": { meses: 4, valor: 90 },
  "5": { meses: 5, valor: 100 }
};

function basicAuth(req, res, next) {
  const h = req.headers.authorization || "";

  if (!h.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="TVPlay Admin"');
    return res.status(401).send("Autenticação necessária.");
  }

  const decoded = Buffer.from(h.slice(6), "base64").toString();
  const i = decoded.indexOf(":");

  if (
    i < 0 ||
    decoded.slice(0, i) !== ADMIN_USER ||
    decoded.slice(i + 1) !== ADMIN_PASSWORD
  ) {
    res.set("WWW-Authenticate", 'Basic realm="TVPlay Admin"');
    return res.status(401).send("Usuário ou senha inválidos.");
  }

  next();
}

function dbError(res, error) {
  console.error("Supabase:", error);
  return res.status(500).json({
    error: "Erro ao acessar o banco de dados."
  });
}

app.get("/api/config", (req, res) => {
  res.json({
    price: 30.0,
    product: "Assinatura TVPlay"
  });
});

app.post("/api/create-payment", async (req, res) => {
  try {
    if (!ACCESS_TOKEN || ACCESS_TOKEN.includes("COLOQUE-")) {
      return res.status(500).json({
        error: "Mercado Pago ainda não configurado no servidor."
      });
    }

    if (!PUBLIC_URL || !PUBLIC_URL.startsWith("https://")) {
      return res.status(500).json({
        error: "PUBLIC_URL precisa ser uma URL HTTPS pública."
      });
    }

    if (!supabase) {
      return res.status(500).json({
        error: "Supabase ainda não configurado no servidor."
      });
    }

    const { name, whatsapp, email, plano } = req.body;

    if (!name || !whatsapp || !email) {
      return res.status(400).json({
        error: "Preencha nome, WhatsApp e e-mail."
      });
    }

    const planoSelecionado = PLANOS[String(plano)];

    if (!planoSelecionado) {
      return res.status(400).json({
        error: "Plano inválido."
      });
    }

    const valor = planoSelecionado.valor;

    const externalReference =
      "TVP-" +
      Date.now() +
      "-" +
      crypto.randomBytes(3).toString("hex");

    const mpRes = await fetch(
      "https://api.mercadopago.com/v1/payments",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          transaction_amount: valor,
          description: "Assinatura TVPlay",
          payment_method_id: "pix",
          external_reference: externalReference,
          payer: { email }
        })
      }
    );

    const data = await mpRes.json();

    if (!mpRes.ok) {
      console.error("Mercado Pago:", data);

      return res.status(mpRes.status).json({
        error: "Mercado Pago recusou a criação do pagamento."
      });
    }

    const payment = data.point_of_interaction?.transaction_data;

    const { error: insertError } = await supabase
      .from("orders")
      .insert({
        id: crypto.randomUUID(),
        order_id: externalReference,
        name,
        whatsapp,
        email,
        plano: planoSelecionado.meses,
        amount: valor,
        status: data.status || "pending",
        mp_payment_id: String(data.id),
        activated_at: null
      });

    if (insertError) {
      return dbError(res, insertError);
    }

    res.json({
      orderId: externalReference,
      status: data.status,
      qrCode: payment?.qr_code || "",
      qrCodeBase64: payment?.qr_code_base64 || "",
      ticketUrl: payment?.ticket_url || ""
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: "Erro interno ao criar pagamento."
    });
  }
});

app.get("/api/status/:orderId", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        error: "Supabase ainda não configurado no servidor."
      });
    }

    const { data: order, error } = await supabase
      .from("orders")
      .select("order_id,status")
      .eq("order_id", req.params.orderId)
      .maybeSingle();

    if (error) return dbError(res, error);

    if (!order) {
      return res.status(404).json({
        error: "Pedido não encontrado."
      });
    }

    res.json({
      orderId: order.order_id,
      status: order.status
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: "Erro interno."
    });
  }
});

app.post("/api/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const type = req.body.type;
    const paymentId = req.body.data?.id;

    if (!paymentId || !ACCESS_TOKEN || !supabase) {
      return;
    }

    const mpRes = await fetch(
     `https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      }
    );

    if (!mpRes.ok) return;

    const payment = await mpRes.json();

    const { data: order, error: findError } = await supabase
      .from("orders")
      .select("*")
      .eq("mp_payment_id", String(payment.id))
      .maybeSingle();

    if (findError) {
      console.error("Webhook Supabase:", findError);
      return;
    }

    if (!order) return;

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: payment.status || order.status
      })
    .eq("order_id", order.order_id);

    if (updateError) {
      console.error("Webhook update:", updateError);
    }
  } catch (e) {
    console.error("Webhook:", e);
  }
});

app.get("/api/admin/orders", basicAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        error: "Supabase ainda não configurado no servidor."
      });
    }

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return dbError(res, error);

    res.json(
      (data || []).map((p) => ({
        id: p.id,
        orderId: p.order_id,
        name: p.name,
        whatsapp: p.whatsapp,
        email: p.email,
        plano: p.plano,
        amount: p.amount,
        status: p.status,
        mpPaymentId: p.mp_payment_id,
        createdAt: p.created_at,
        activatedAt: p.activated_at
      }))
    );
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: "Erro interno."
    });
  }
});

app.post("/api/admin/orders/:id/activate", basicAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        error: "Supabase ainda não configurado no servidor."
      });
    }

    const { data: order, error: findError } = await supabase
      .from("orders")
      .select("id")
      .eq("id", req.params.id)
      .maybeSingle();

    if (findError) return dbError(res, findError);

    if (!order) {
      return res.status(404).json({
        error: "Pedido não encontrado."
      });
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: "activated",
        activated_at: new Date().toISOString()
      })
      .eq("id", req.params.id);

    if (updateError) return dbError(res, updateError);

    res.json({
      ok: true
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: "Erro interno."
    });
  }
});

app.get("/admin", basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});
app.listen(PORT, "0.0.0.0", () => {
  `console.log(TVPlay portal rodando na porta ${PORT})`;
});
