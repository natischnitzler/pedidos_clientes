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

    // 2. Buscar ventas del partner (filtrar por fecha si se pasa)
    const fromDate = req.query.from || null;
    const toDate   = req.query.to   || null;
    const domain   = [['partner_id', '=', partnerId]];
    if (fromDate) domain.push(['date_order', '>=', fromDate + ' 00:00:00']);
    if (toDate)   domain.push(['date_order', '<=', toDate   + ' 23:59:59']);
    const ventas = await xmlrpcCall('sale.order', 'search_read', [
      domain,
      ['name', 'date_order', 'state', 'invoice_status', 'amount_total', 'order_line', 'note', 'invoice_ids'],
      0, 200, 'date_order desc'
    ]);

    // 3. Para cada venta obtener sus líneas
    const result = await Promise.all(ventas.map(async function(v) {
      let productos = [];
      if (v.order_line && v.order_line.length) {
        const lines = await xmlrpcCall('sale.order.line', 'search_read', [
          [['order_id', '=', v.id]],
          ['product_id', 'product_uom_qty', 'price_unit']
        ]);
        productos = lines.map(function(l) {
          const nombre = l.product_id ? l.product_id[1] : '';
          // Extraer SKU del nombre: "[CS-MQ247B2] RELOJ CASIO..."
          const skuMatch = nombre.match(/^\[([^\]]+)\]/);
          const sku = skuMatch ? skuMatch[1] : nombre;
          return {
            Sku:      sku,
            Producto: nombre.replace(/^\[[^\]]+\]\s*/, ''),
            Cantidad: l.product_uom_qty,
            Precio:   l.price_unit
          };
        });
      }
      // Estado: si invoice_status=invoiced -> done (facturado)
      const estado = v.invoice_status === 'invoiced' ? 'done' : (v.state || 'draft');

      // Facturas asociadas
      let facturas = [];
      if (v.invoice_ids && v.invoice_ids.length) {
        try {
          const invs = await xmlrpcCall('account.move', 'read', [
            v.invoice_ids,
            ['id', 'name', 'state', 'payment_state']
          ]);
          facturas = invs
            .filter(i => i.state === 'posted')
            .map(i => ({
              id:   i.id,
              name: i.name
            }));
        } catch(e) { /* ignorar */ }
      }

      return {
        id:        v.id,
        nombre:    v.name,
        fecha:     v.date_order ? v.date_order.split(' ')[0] : '',
        obs:       v.note || '',
        estado:    estado,
        total:     v.amount_total,
        facturas:  facturas,
        productos: productos
      };
    }));

    res.json(result);
  } catch(e) {
    console.error('❌ /api/historial', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/deuda ───────────────────────────────────────────────
// Igual que el reporte de vendedores: usa account.move.line con
// cuentas A110402 para capturar FAC, ND, NC y asientos APER/
app.get('/api/deuda', requireApiKey, async (req, res) => {
  try {
    const partnerId = req.partnerId;
    const hoy = new Date();

    // 1. Buscar cuentas por cobrar (A110402)
    let receivableIds = await xmlrpcCall('account.account', 'search', [
      [['code', '=like', 'A110402%']]
    ]);
    if (!receivableIds.length) {
      receivableIds = await xmlrpcCall('account.account', 'search', [
        [['account_type', '=', 'asset_receivable']]
      ]);
    }
    if (!receivableIds.length) {
      return res.status(500).json({ error: 'No se encontraron cuentas por cobrar' });
    }

    // 2. Líneas no reconciliadas de ese partner
    const amlIds = await xmlrpcCall('account.move.line', 'search', [[
      ['account_id',        'in',  receivableIds],
      ['move_id.state',     '=',   'posted'],
      ['partner_id',        '=',   partnerId],
      ['full_reconcile_id', '=',   false]
    ]]);

    if (!amlIds.length) return res.json({ facturas: [], resumen: {} });

    const amlList = await xmlrpcCall('account.move.line', 'read', [
      amlIds,
      ['move_id', 'date_maturity', 'date', 'debit', 'credit',
       'amount_residual', 'full_reconcile_id', 'name']
    ]);

    // Filtrar: saldo real > 0
    const lineas = amlList.filter(l =>
      !l.full_reconcile_id &&
      (parseFloat(l.amount_residual || 0) > 0 ||
       parseFloat(l.debit || 0) > parseFloat(l.credit || 0))
    );

    if (!lineas.length) return res.json({ facturas: [], resumen: {} });

    // 3. Prefetch datos del asiento (nombre, fecha)
    const moveIds = [...new Set(lineas.map(l => Array.isArray(l.move_id) ? l.move_id[0] : l.move_id).filter(Boolean))];
    const moves   = await xmlrpcCall('account.move', 'read', [
      moveIds,
      ['id', 'name', 'ref', 'invoice_date', 'invoice_date_due', 'move_type']
    ]);
    const moveMap = {};
    moves.forEach(m => moveMap[m.id] = m);

    // 4. Armar facturas con tramos
    const today = new Date(); today.setHours(0,0,0,0);
    const facturas = [];

    lineas.forEach(l => {
      const saldo = parseFloat(l.amount_residual || 0);
      if (saldo <= 0) return;

      const moveId  = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
      const move    = moveMap[moveId] || {};
      const ref     = (move.ref || '').toLowerCase();

      // Excluir cheques en cartera
      if (ref.includes('cheque') && ref.includes('cartera')) return;

      const fechaVenc = new Date(l.date_maturity || move.invoice_date_due || l.date || today);
      const dias = Math.floor((today - fechaVenc) / 86400000);

      let tramo = 'al_dia';
      if      (dias <= 0)   tramo = 'al_dia';
      else if (dias <= 30)  tramo = 'd_1_30';
      else if (dias <= 60)  tramo = 'd_31_60';
      else if (dias <= 90)  tramo = 'd_61_90';
      else if (dias <= 120) tramo = 'd_91_120';
      else                  tramo = 'antiguos';

      const moveName = move.name || '';
      const lineNom  = (l.name || '').trim();
      let   docLabel = moveName;
      if (moveName.startsWith('APER/') && lineNom && lineNom !== '/') {
        docLabel = moveName + ' – ' + lineNom;
      }

      facturas.push({
        doc:         docLabel,
        move_name:   moveName,
        ref:         move.invoice_origin || move.ref || '',
        fecha:       move.invoice_date || l.date || '',
        vencimiento: l.date_maturity   || move.invoice_date_due || '',
        dias:        dias,
        tramo:       tramo,
        saldo:       saldo,
        move_id:     moveId
      });
    });

    // 5. Resumen por tramo
    const resumen = { al_dia: 0, d_1_30: 0, d_31_60: 0, d_61_90: 0, d_91_120: 0, antiguos: 0, total: 0 };
    facturas.forEach(f => {
      resumen[f.tramo] = (resumen[f.tramo] || 0) + f.saldo;
      resumen.total    += f.saldo;
    });

    // Ordenar por fecha
    facturas.sort((a, b) => a.fecha > b.fecha ? -1 : 1);

    res.json({ facturas, resumen });
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
