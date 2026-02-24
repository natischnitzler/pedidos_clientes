const express = require('express');
const xmlrpc  = require('xmlrpc');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ODOO_URL  = 'https://temponovo.odoo.com';
const ODOO_DB   = 'cmcorpcl-temponovo-main-24490235';
const ODOO_USER = 'natalia@temponovo.cl';
const ODOO_PASS = process.env.ODOO_PASSWORD || '';


// ── CLIENTES ─────────────────────────────────────────────────────
// Agregar nuevos clientes aquí
const CLIENTES = {
  'LARELOJERIA': {
    apiKey:    process.env.APIKEY_LARELOJERIA || '22f7ebb65ec6646888a4c22028a854e39e310b31c5461cc52d22e835d92d5bd6',
    partnerId: 51666,
    name:      'La Relojería SPA'
  }
  // 'OTOCLIENTE': {
  //   apiKey:    process.env.APIKEY_OTOCLIENTE || '',
  //   partnerId: 12345,
  //   name:      'Otro Cliente'
  // }
};

function getCliente(code) {
  return CLIENTES[(code||'').toUpperCase()] || null;
}

// ── AUTH CACHE ───────────────────────────────────────────────────
let cachedUID    = null;
let lastAuthTime = 0;
const AUTH_TTL   = 3600000; // 1 hora

async function getUID() {
  if (cachedUID && (Date.now() - lastAuthTime) < AUTH_TTL) return cachedUID;

  const client = xmlrpc.createSecureClient({
    host: new URL(ODOO_URL).hostname,
    port: 443,
    path: '/xmlrpc/2/common'
  });

  return new Promise((resolve, reject) => {
    client.methodCall('authenticate',
      [ODOO_DB, ODOO_USER, ODOO_PASS, {}],
      (err, uid) => {
        if (err) return reject(err);
        cachedUID    = uid;
        lastAuthTime = Date.now();
        console.log('✅ UID Odoo:', uid);
        resolve(uid);
      }
    );
  });
}

function xmlrpcCall(model, method, args) {
  return getUID().then(uid => {
    const client = xmlrpc.createSecureClient({
      host: new URL(ODOO_URL).hostname,
      port: 443,
      path: '/xmlrpc/2/object'
    });
    return new Promise((resolve, reject) => {
      client.methodCall('execute_kw',
        [ODOO_DB, uid, ODOO_PASS, model, method, args],
        (err, result) => err ? reject(err) : resolve(result)
      );
    });
  });
}

// ── PROXY HELPER — llama a la API REST de Odoo con API key del cliente ──
async function odooProxy(path, apiKey, options = {}) {
  const url  = ODOO_URL + path;
  const opts = {
    method:  options.method  || 'GET',
    headers: {
      'Authorization':  apiKey,
      'Content-Type':   'application/json',
      ...( options.headers || {} )
    }
  };
  if (options.body) opts.body = JSON.stringify(options.body);

  const res  = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── MIDDLEWARE: validar código de cliente ────────────────────────
async function requireApiKey(req, res, next) {
  const code = (req.headers['x-client-code'] || '').toUpperCase();
  if (!code) return res.status(401).json({ error: 'Código de cliente requerido' });
  const cliente = getCliente(code);
  if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });
  req.apiKey    = cliente.apiKey;
  req.partnerId = cliente.partnerId;
  req.clientName = cliente.name;
  next();
}

// ── GET /api/stock ────────────────────────────────────────────────
// Proxy a Odoo REST con la API key del cliente (incluye sus precios)
app.get('/api/stock', async (req, res) => {
  try {
    const code    = (req.headers['x-client-code'] || '').toUpperCase();
    const cliente = getCliente(code);
    if (!cliente) return res.status(401).json({ error: 'Código no reconocido' });
    const r = await odooProxy('/api/stock', cliente.apiKey);
    if (!r.ok) return res.status(r.status).json({ error: 'Error Odoo stock', detail: r.data });
    res.json(r.data);
  } catch(e) {
    console.error('❌ /api/stock', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pedido ──────────────────────────────────────────────
// Proxy a /sale/create de Odoo con la API key del cliente
app.post('/api/pedido', requireApiKey, async (req, res) => {
  try {
    const r = await odooProxy('/sale/create', req.apiKey, {
      method: 'POST',
      body:   req.body
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Error Odoo pedido', detail: r.data });
    res.json(r.data);
  } catch(e) {
    console.error('❌ /api/pedido', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/sale ─────────────────────────────────────────────────
// Proxy a /api/sale de Odoo con la API key del cliente
app.get('/api/sale', requireApiKey, async (req, res) => {
  try {
    const idVenta = req.headers['idventa'];
    const headers = idVenta ? { 'Idventa': idVenta } : {};
    const r = await odooProxy('/api/sale', req.apiKey, { headers });
    if (!r.ok) return res.status(r.status).json({ error: 'Error Odoo sale', detail: r.data });
    res.json(r.data);
  } catch(e) {
    console.error('❌ /api/sale', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/historial ────────────────────────────────────────────
// Devuelve todos los pedidos del cliente según su API key
app.get('/api/historial', requireApiKey, async (req, res) => {
  try {
    // 1. Buscar partner
    const partnerId = req.partnerId;

    // 2. Buscar ventas del partner
    const ventas = await xmlrpcCall('sale.order', 'search_read', [
      [[['partner_id', '=', partnerId]]],
      ['name', 'date_order', 'state', 'amount_total',
       'tempo_observation', 'tempo_type_sale', 'order_line'],
      0, 100, 'date_order desc'
    ]);

    // 3. Para cada venta obtener sus líneas
    const result = await Promise.all(ventas.map(async function(v) {
      let productos = [];
      if (v.order_line && v.order_line.length) {
        const lines = await xmlrpcCall('sale.order.line', 'search_read', [
          [[['order_id', '=', v.id]]],
          ['product_id', 'product_uom_qty', 'price_unit', 'default_code']
        ]);
        productos = lines.map(function(l) {
          return {
            Sku:      l.default_code || (l.product_id ? l.product_id[1] : ''),
            Producto: l.product_id ? l.product_id[1] : '',
            Cantidad: l.product_uom_qty,
            Precio:   l.price_unit
          };
        });
      }
      return {
        id:     v.id,
        nombre: v.name,
        fecha:  v.date_order ? v.date_order.split(' ')[0] : '',
        tipo:   v.tempo_type_sale || '',
        obs:    v.tempo_observation || '',
        estado: v.state,
        total:  v.amount_total,
        productos: productos
      };
    }));

    res.json(result);
  } catch(e) {
    console.error('❌ /api/historial', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/deuda ────────────────────────────────────────────────
// Usa XML-RPC con credenciales propias — busca partner por API key
// y devuelve sus cuentas por cobrar vencidas
app.get('/api/deuda', requireApiKey, async (req, res) => {
  try {
    // 1. Buscar partner que tenga esta API key
    const partnerId = req.partnerId;

    // 2. Obtener facturas pendientes (account.move)
    const facturas = await xmlrpcCall('account.move', 'search_read', [
      [[
        ['partner_id',    '=',  partnerId],
        ['move_type',     '=',  'out_invoice'],
        ['payment_state', 'in', ['not_paid', 'partial']],
        ['state',         '=',  'posted']
      ]],
      ['name', 'invoice_date', 'invoice_date_due', 'amount_residual', 'payment_state']
    ]);

    // 3. Calcular tramo por fecha de vencimiento
    const hoy = new Date();
    const result = facturas.map(function(f) {
      const venc  = f.invoice_date_due ? new Date(f.invoice_date_due) : null;
      const dias  = venc ? Math.floor((hoy - venc) / 86400000) : 0;
      const tramo = dias > 0 ? 'vencido' : 'al_dia';
      return {
        num:         f.name,
        fecha:       f.invoice_date       || '',
        vencimiento: f.invoice_date_due   || '',
        monto:       f.amount_residual    || 0,
        tramo:       tramo,
        dias_vencido: dias > 0 ? dias : 0
      };
    });

    res.json(result);
  } catch(e) {
    console.error('❌ /api/deuda', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/me ───────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const code    = (req.headers['x-client-code'] || '').toUpperCase();
  const cliente = getCliente(code);
  if (!cliente) return res.status(401).json({ error: 'Código no reconocido' });
  req.clientName = cliente.name;
  req.partnerId  = cliente.partnerId;
  res.json({ name: req.clientName, partnerId: req.partnerId });
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Portal API corriendo en puerto ${PORT}`);
});
