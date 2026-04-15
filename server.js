// ============================================================
// XOTICS TRANSPORTATION — Sistema de Reservaciones v2
// server.js — Sin dependencias externas (solo Node.js nativo)
// ============================================================

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

// ─── CARGAR .env ─────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '.env');
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  });
} catch (_) {}

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC    = path.join(__dirname, 'public');

// ─── UBICACIÓN ESPERADA (Reloj Checador) ─────────────────────
// Coordenadas del punto central de trabajo (configurable)
const EXPECTED_LAT           = 20.588859;
const EXPECTED_LNG           = -87.112130;
const EXPECTED_RADIUS_KM     = 0.60;     // 600 metros de radio
const EXPECTED_LOCATION_NAME = 'Playa del Carmen – Xotics Transportation';

// ─── HAVERSINE (distancia entre dos puntos GPS en km) ────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2
             + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180)
             * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── HELPERS ────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = ()  => crypto.randomUUID();

// ─── CANCÚN TIMEZONE (UTC-5, sin horario de verano) ─────────
const CANCUN_TZ = 'America/Cancun';
function cancunDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CANCUN_TZ, year:'numeric', month:'2-digit', day:'2-digit'
  }).format(d);
}
function cancunWeekdayNum(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: CANCUN_TZ, weekday:'short' }).format(d);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(s);
}
function cancunMondayStr(d = new Date()) {
  const dow = cancunWeekdayNum(d);
  const daysFromMon = (dow + 6) % 7;
  return cancunDateStr(new Date(d.getTime() - daysFromMon * 86400000));
}
function cancunWeekRange(weeksAgo = 0, d = new Date()) {
  const dow = cancunWeekdayNum(d);
  const daysFromMon = (dow + 6) % 7;
  const thisMonMs = d.getTime() - daysFromMon * 86400000;
  const monMs  = thisMonMs - weeksAgo * 7 * 86400000;
  const sunMs  = monMs + 6 * 86400000;
  return { start: cancunDateStr(new Date(monMs)), end: cancunDateStr(new Date(sunMs)) };
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) return initData();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return initData(); }
}
function writeData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8');
}
function initData() {
  const d = {
    bookingCounter: 0,
    users: [
      { id:'u1', username:'admin',       password:sha('Xotics2026'), nombre:'Administrador Único',  rol:'admin_unico'  },
      { id:'u2', username:'admin2',      password:sha('Xotics2026'), nombre:'Administrador',        rol:'admin'        },
      { id:'u3', username:'coordinador', password:sha('Xotics2026'), nombre:'Coordinador General',  rol:'coordinador'  },
      { id:'u4', username:'asesor',      password:sha('Xotics2026'), nombre:'Asesor de Ventas',     rol:'asesor'       },
      { id:'u5', username:'driver1',     password:sha('Xotics2026'), nombre:'Carlos López',         rol:'driver'       },
      { id:'u6', username:'driver2',     password:sha('Xotics2026'), nombre:'Miguel Hernández',     rol:'driver'       },
    ],
    vehicles: [
      { id:'v1',  nombre:'Sedan 1',            tipo:'sedan',    capacidad:3  },
      { id:'v2',  nombre:'Sedan 2',            tipo:'sedan',    capacidad:3  },
      { id:'v3',  nombre:'Sedan 3',            tipo:'sedan',    capacidad:3  },
      { id:'v4',  nombre:'Sedan 4',            tipo:'sedan',    capacidad:3  },
      { id:'v5',  nombre:'Sedan 5',            tipo:'sedan',    capacidad:3  },
      { id:'v6',  nombre:'Sedan 6',            tipo:'sedan',    capacidad:3  },
      { id:'v7',  nombre:'Minivan (5 Pax)',     tipo:'minivan',  capacidad:5  },
      { id:'v8',  nombre:'Suburban Chevrolet', tipo:'suburban', capacidad:5  },
      { id:'v9',  nombre:'Urvan 1 (13 Pax)',   tipo:'van13',    capacidad:13 },
      { id:'v10', nombre:'Urvan 2 (13 Pax)',   tipo:'van13',    capacidad:13 },
    ],
    bookings: [],
    welcomeCounter: 0,
    welcomes: [],
    checadaCounter: 0,
    checadas: []
  };
  writeData(d); return d;
}

// ─── HELPER: ¿servicio inicia en ≤60 min en Cancún? ─────────
function isWithinOneHour(fecha, hora, nowMs) {
  if (!fecha || !hora) return false;
  const [hh, mm] = hora.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return false;
  // Cancún = UTC-5 (sin horario de verano)
  const serviceMs = Date.parse(`${fecha}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00-05:00`);
  if (isNaN(serviceMs)) return false;
  const diff = serviceMs - nowMs;
  return diff >= 0 && diff <= 3600000;
}

// ─── ROLES ──────────────────────────────────────────────────
// admin_unico : acceso total (gestión completa de usuarios)
// admin       : mismo que admin_unico pero sin crear/eliminar usuarios ni cambiar contraseñas
// coordinador : calendario, reservaciones, crear reservaciones, asignar drivers
// asesor      : crear reservaciones (sin driver/vehículo), calendario, historial
// driver      : solo ver sus viajes asignados y actualizar estatus

const ADMIN_ROLES  = ['admin_unico', 'admin'];
const STAFF_ROLES  = ['admin_unico', 'admin', 'coordinador', 'asesor'];
const CAN_CREATE   = ['admin_unico', 'admin', 'coordinador', 'asesor'];
const CAN_ASSIGN   = ['admin_unico', 'admin', 'coordinador'];  // pueden asignar driver/vehículo
const STATS_ROLES  = ['admin_unico', 'admin'];

// ─── SESSION STORE (in-memory) ───────────────────────────────
const sessions = {};
function createSession() {
  const sid = uid();
  sessions[sid] = { id: sid, userId: null, userRol: null, created: Date.now() };
  return sid;
}
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sid = cookies['xsid'];
  if (sid && sessions[sid]) {
    if (Date.now() - sessions[sid].created > 10 * 3600 * 1000) {
      delete sessions[sid]; return null;
    }
    return sessions[sid];
  }
  return null;
}
function parseCookies(str) {
  return str.split(';').reduce((o, p) => {
    const [k, v] = p.trim().split('=');
    if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || '');
    return o;
  }, {});
}

// ─── STATIC FILE TYPES ───────────────────────────────────────
const MIME = {
  '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
  '.ico':'image/x-icon', '.svg':'image/svg+xml', '.woff2':'font/woff2'
};

// ─── RESPONSE HELPERS ────────────────────────────────────────
function json(res, data, status=200, setCookie) {
  const body = JSON.stringify(data);
  const headers = { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(status, headers);
  res.end(body);
}
function err(res, msg, status=400) { json(res, { error: msg }, status); }

// ─── BODY PARSER ─────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── ENRICH BOOKING ──────────────────────────────────────────
const _TIPO_DISP = {
  sedan:'Sedan', minivan:'Minivan', van:'Van / Urvan',
  van8:'Van / Urvan', van13:'Van / Urvan (13)', suburban:'Suburban', sprinter:'Sprinter'
};
function enrich(b, data) {
  const v       = data.vehicles.find(v => v.id === b.vehiculoId);
  const c       = data.users.find(u => u.id === b.driverId);
  const creator = data.users.find(u => u.id === b.creadoPor);
  const vehiculoNombre = v
    ? v.nombre
    : (_TIPO_DISP[b.vehiculoTipo] || _TIPO_DISP[b.vehiculoId] || 'Sin vehículo');
  return {
    ...b,
    vehiculoNombre,
    driverNombre:    c       ? c.nombre       : 'Sin asignar',
    creadoPorNombre: creator ? creator.nombre : '—'
  };
}

// ─── SERVE STATIC ────────────────────────────────────────────
function serveStatic(res, filePath) {
  fs.readFile(filePath, (e, data) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ════════════════════════════════════════════════════════════
// EMAIL — Resend API (nativo, sin dependencias npm)
// ════════════════════════════════════════════════════════════
function buildConfirmationEmail(b) {
  const TIPO_LABEL = { traslado:'Traslado', retorno:'Retorno', 'servicio-abierto':'Servicio Abierto', 'servicio-redondo':'Servicio Redondo', otro:'Otro' };
  const fmt  = (v, fallback='—') => (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : fallback;
  const fmxn = v => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(parseFloat(v)||0);

  const tipoLabel = TIPO_LABEL[b.tipoServicio] || fmt(b.tipoServicio);
  const vuelo     = fmt(b.numeroVuelo, null);
  const notas     = fmt(b.notas, null);

  const rowStyle   = 'display:flex;justify-content:space-between;align-items:flex-start;padding:10px 0;border-bottom:1px solid #eaecf1;font-size:14px;';
  const labelStyle = 'color:#6b7280;font-weight:600;min-width:150px;flex-shrink:0;';
  const valStyle   = 'color:#111827;text-align:right;font-weight:500;';
  const row = (label, value) =>
    `<div style="${rowStyle}"><span style="${labelStyle}">${label}</span><span style="${valStyle}">${value}</span></div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirmación de Reservación</title></head>
<body style="margin:0;padding:0;background:#f0f2f6;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:40px auto;padding:0 16px 40px;">

  <!-- HEADER -->
  <div style="background:#ea1481;border-radius:14px 14px 0 0;padding:32px 36px;text-align:center;">
    <div style="font-size:30px;font-weight:900;letter-spacing:4px;color:#fff;">XOTICS</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.80);letter-spacing:3px;text-transform:uppercase;margin-top:4px;">Transportation</div>
    <div style="margin-top:18px;background:rgba(255,255,255,0.18);border-radius:8px;padding:10px 20px;display:inline-block;">
      <span style="color:#fff;font-size:15px;font-weight:700;">Reservacion Confirmada</span>
    </div>
  </div>

  <!-- BOOKING ID -->
  <div style="background:#fff;border-left:4px solid #ea1481;border-right:4px solid #ea1481;padding:20px 36px;text-align:center;">
    <div style="color:#6b7280;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Numero de Reservacion</div>
    <div style="font-size:36px;font-weight:900;color:#ea1481;letter-spacing:6px;margin-top:4px;">#${fmt(b.bookingId)}</div>
  </div>

  <!-- GREETING -->
  <div style="background:#fff;border-left:4px solid #ea1481;border-right:4px solid #ea1481;padding:0 36px 20px;">
    <p style="font-size:15px;color:#111827;margin:0;">
      Hola <strong>${fmt(b.huespedNombre)}</strong>, tu reservacion ha sido registrada exitosamente.
      A continuacion encontraras el resumen de tu servicio.
    </p>
  </div>

  <!-- DETAILS CARD -->
  <div style="background:#fff;border-radius:0 0 14px 14px;padding:24px 36px 30px;border:1px solid #dde1ea;border-top:none;">

    <p style="font-size:12px;font-weight:700;color:#ea1481;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px;">Detalles del Servicio</p>
    ${row('Tipo de Servicio', tipoLabel)}
    ${row('Fecha', fmt(b.fecha))}
    ${row('Hora', fmt(b.hora))}
    ${row('Origen', fmt(b.origen))}
    ${row('Destino', fmt(b.destino))}
    ${row('No. de Pasajeros', fmt(b.pasajeros))}
    ${vuelo ? row('No. de Vuelo', vuelo) : ''}

    <p style="font-size:12px;font-weight:700;color:#ea1481;letter-spacing:2px;text-transform:uppercase;margin:20px 0 4px;">Precio</p>
    <div style="background:#fdf3f9;border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
      <span style="font-size:13px;color:#6b7280;font-weight:600;">Total a pagar</span>
      <span style="font-size:22px;font-weight:900;color:#ea1481;">${fmxn(b.precio)}</span>
    </div>

    ${notas ? `
    <p style="font-size:12px;font-weight:700;color:#ea1481;letter-spacing:2px;text-transform:uppercase;margin:20px 0 4px;">Notas Especiales</p>
    <div style="background:#f5f6fa;border-radius:8px;padding:12px 16px;font-size:13px;color:#374151;">${notas}</div>` : ''}

    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #eaecf1;text-align:center;">
      <p style="font-size:14px;color:#374151;margin:0 0 6px;">
        Gracias por elegir <strong style="color:#ea1481;">Xotics Transportation</strong>.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        Si tienes alguna pregunta sobre tu servicio, no dudes en contactarnos.
      </p>
    </div>
  </div>

</div>
</body>
</html>`;
}

// ─── Resend REST API ─────────────────────────────────────────
function sendConfirmationEmail(booking) {
  const apiKey   = process.env.RESEND_API_KEY;
  const fromAddr = process.env.RESEND_FROM || 'Xotics Transportation <onboarding@resend.dev>';

  if (!apiKey) { console.warn('[email] RESEND_API_KEY no configurada — correo omitido.'); return; }
  if (!booking.huespedEmail) { console.warn('[email] Sin email del huesped — correo omitido.'); return; }

  const payload = JSON.stringify({
    from:    fromAddr,
    to:      [booking.huespedEmail],
    subject: `✅ Confirmacion de tu reservacion #${booking.bookingId} - Xotics Transportation`,
    html:    buildConfirmationEmail(booking)
  });

  const options = {
    hostname: 'api.resend.com',
    path:     '/emails',
    method:   'POST',
    headers: {
      'Authorization':  `Bearer ${apiKey}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  // Fire-and-forget — no bloquea la respuesta al frontend
  setImmediate(() => {
    const req = https.request(options, (r) => {
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          console.log(`[email] ✅ Confirmacion enviada a ${booking.huespedEmail} (reservacion #${booking.bookingId})`);
        } else {
          console.error(`[email] ❌ Error Resend ${r.statusCode}:`, body);
        }
      });
    });
    req.on('error', e => console.error('[email] ❌ Error de red:', e.message));
    req.write(payload);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method;
  const query    = parsed.query;

  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ── STATIC FILES ─────────────────────────────────────────
  if (!pathname.startsWith('/api/')) {
    const file = pathname === '/' ? '/index.html' : pathname;
    const abs  = path.join(PUBLIC, file.replace(/\.\./g, ''));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      serveStatic(res, abs); return;
    }
    serveStatic(res, path.join(PUBLIC, 'index.html')); return;
  }

  // ── API ROUTES ────────────────────────────────────────────
  try {
    let body = {};
    if (['POST','PUT','PATCH'].includes(method)) body = await parseBody(req);

    const sess = getSession(req);

    // POST /api/login
    if (pathname === '/api/login' && method === 'POST') {
      const { username, password } = body;
      if (!username || !password) return err(res, 'Datos incompletos');
      const data = readData();
      const user = data.users.find(u => u.username === username && u.password === sha(password));
      if (!user) return err(res, 'Usuario o contraseña incorrectos', 401);
      const sid = createSession();
      sessions[sid].userId  = user.id;
      sessions[sid].userRol = user.rol;
      const cookie = `xsid=${sid}; HttpOnly; Path=/; Max-Age=36000; SameSite=Lax`;
      return json(res, { id:user.id, username:user.username, nombre:user.nombre, rol:user.rol }, 200, cookie);
    }

    // POST /api/logout
    if (pathname === '/api/logout' && method === 'POST') {
      if (sess) delete sessions[sess.id];
      return json(res, { ok:true }, 200, 'xsid=; Path=/; Max-Age=0');
    }

    // GET /api/me
    if (pathname === '/api/me' && method === 'GET') {
      if (!sess?.userId) return err(res, 'No autenticado', 401);
      const data = readData();
      const user = data.users.find(u => u.id === sess.userId);
      if (!user) return err(res, 'Usuario no encontrado', 404);
      return json(res, { id:user.id, username:user.username, nombre:user.nombre, rol:user.rol });
    }

    // ── REQUIRE AUTH ─────────────────────────────────────────
    if (!sess?.userId) return err(res, 'No autenticado', 401);
    const rol = sess.userRol;

    // GET /api/bookings
    if (pathname === '/api/bookings' && method === 'GET') {
      const data = readData();
      let list = [...data.bookings];
      if (rol === 'driver') list = list.filter(b => b.driverId === sess.userId);
      if (query.fecha) list = list.filter(b => b.fecha === query.fecha);
      if (query.mes)   list = list.filter(b => b.fecha?.startsWith(query.mes));
      list.sort((a, b) => {
        const da = new Date(`${a.fecha}T${a.hora||'00:00'}`);
        const db = new Date(`${b.fecha}T${b.hora||'00:00'}`);
        return da - db;
      });
      return json(res, list.map(b => enrich(b, data)));
    }

    // GET /api/bookings/:id
    const bmatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
    if (bmatch && method === 'GET') {
      const data = readData();
      const b = data.bookings.find(b => b.id === bmatch[1]);
      if (!b) return err(res, 'Reservación no encontrada', 404);
      if (rol === 'driver' && b.driverId !== sess.userId) return err(res, 'Sin permiso', 403);
      return json(res, enrich(b, data));
    }

    // POST /api/bookings
    if (pathname === '/api/bookings' && method === 'POST') {
      if (!CAN_CREATE.includes(rol)) return err(res, 'Sin permiso', 403);
      const data = readData();
      if (typeof data.bookingCounter !== 'number') data.bookingCounter = 0;
      data.bookingCounter += 1;
      const bookingId = String(data.bookingCounter).padStart(4, '0');

      const booking = {
        id:              uid(),
        bookingId:       bookingId,
        huespedNombre:   body.huespedNombre   || '',
        huespedTelefono: body.huespedTelefono || '',
        huespedEmail:    body.huespedEmail    || '',
        tipoServicio:    body.tipoServicio     || 'traslado',
        origenTipo:      body.origenTipo       || '',   // HXM | HXM II | HXA | OTRO
        origen:          body.origen           || '',
        origenTitulo:    body.origenTitulo     || '',   // Título personalizado de origen
        destino:         body.destino          || '',
        fecha:           body.fecha            || '',
        hora:            body.hora             || '',
        horaRegreso:     body.horaRegreso      || '',   // Para Servicio Redondo
        pasajeros:       parseInt(body.pasajeros)  || 1,
        habitacion:      body.habitacion       || '',
        referido:        body.referido         || '',
        numeroVuelo:     body.numeroVuelo      || '',
        vehiculoId:      CAN_ASSIGN.includes(rol) ? (body.vehiculoId  || '') : '',
        vehiculoTipo:    CAN_ASSIGN.includes(rol) ? (body.vehiculoTipo|| '') : '',
        driverId:        CAN_ASSIGN.includes(rol) ? (body.driverId    || '') : '',
        precio:          parseFloat(body.precio)   || 0,
        horas:           parseInt(body.horas)      || 0,
        metodoPago:      body.metodoPago       || '',
        estatusPago:     body.estatusPago      || 'pagado',
        estatusViaje:    'pendiente',
        serviceStartTime: null,
        notas:           body.notas            || '',
        creadoPor:       sess.userId,
        creadoEn:        new Date().toISOString()
      };
      data.bookings.push(booking);
      writeData(data);
      const enriched = enrich(booking, data);
      json(res, enriched, 201);                    // Responder al frontend primero
      sendConfirmationEmail(enriched);             // Email en background (no bloquea)
      return;
    }

    // PUT /api/bookings/:id — editar reservación
    if (bmatch && method === 'PUT') {
      const data = readData();
      const idx  = data.bookings.findIndex(b => b.id === bmatch[1]);
      if (idx === -1) return err(res, 'Reservación no encontrada', 404);

      if (rol === 'driver') {
        // Driver solo puede actualizar estatus de su propio viaje
        if (data.bookings[idx].driverId !== sess.userId) return err(res, 'Sin permiso', 403);
        const updates = { estatusViaje: body.estatusViaje };
        if (body.estatusViaje === 'en-camino') updates.serviceStartTime = new Date().toISOString();
        if (body.estatusViaje === 'completado') updates.serviceEndTime = new Date().toISOString();
        data.bookings[idx] = { ...data.bookings[idx], ...updates };
      } else if (CAN_CREATE.includes(rol)) {
        const prev = data.bookings[idx];
        data.bookings[idx] = {
          ...prev, ...body,
          id:        prev.id,
          bookingId: prev.bookingId,
          precio:    parseFloat(body.precio)    || prev.precio,
          pasajeros: parseInt(body.pasajeros)   || prev.pasajeros,
          horas:     parseInt(body.horas)       || prev.horas,
          // Asesor no puede asignar driver/vehículo
          vehiculoId:   CAN_ASSIGN.includes(rol) ? (body.vehiculoId   ?? prev.vehiculoId)   : prev.vehiculoId,
          vehiculoTipo: CAN_ASSIGN.includes(rol) ? (body.vehiculoTipo ?? prev.vehiculoTipo) : prev.vehiculoTipo,
          driverId:   CAN_ASSIGN.includes(rol) ? (body.driverId   ?? prev.driverId)   : prev.driverId,
        };
      } else {
        return err(res, 'Sin permiso', 403);
      }
      writeData(data);
      return json(res, enrich(data.bookings[idx], data));
    }

    // DELETE /api/bookings/:id
    if (bmatch && method === 'DELETE') {
      if (!ADMIN_ROLES.includes(rol)) return err(res, 'Sin permiso', 403);
      const data = readData();
      const idx  = data.bookings.findIndex(b => b.id === bmatch[1]);
      if (idx === -1) return err(res, 'Reservación no encontrada', 404);
      data.bookings.splice(idx, 1);
      writeData(data);
      return json(res, { ok:true });
    }

    // GET /api/users
    if (pathname === '/api/users' && method === 'GET') {
      if (!ADMIN_ROLES.includes(rol) && rol !== 'coordinador') return err(res, 'Sin permiso', 403);
      const data = readData();
      return json(res, data.users.map(u => ({ id:u.id, username:u.username, nombre:u.nombre, rol:u.rol })));
    }

    // GET /api/drivers  — lista de drivers con estatus actual (3 estados + regla 1 hora)
    if (pathname === '/api/drivers' && method === 'GET') {
      if (!['admin_unico','admin','coordinador'].includes(rol)) return err(res, 'Sin permiso', 403);
      const data    = readData();
      const drivers = data.users.filter(u => u.rol === 'driver');
      const nowMs   = Date.now();
      const todayCancun = cancunDateStr(new Date(nowMs));
      const welcomes = data.welcomes || [];

      // Checadas de hoy (para ordenamiento por hora de entrada)
      const checadasHoy = (data.checadas || []).filter(c => c.fecha === todayCancun);

      const result = drivers.map(d => {
        // 1. EN SERVICIO: booking o welcome con estatusViaje = 'en-camino'
        const enServicioBooking = data.bookings.find(b =>
          b.driverId === d.id && b.estatusViaje === 'en-camino');
        const enServicioWelcome = welcomes.find(w =>
          w.driverId === d.id && w.estatusViaje === 'en-camino');
        const enServicio = enServicioBooking || enServicioWelcome;

        // 2. PENDIENTE: tiene servicio hoy que inicia en ≤60 min (y no está en-camino)
        const pendienteBooking = !enServicio && data.bookings.find(b =>
          b.driverId === d.id && b.estatusViaje === 'pendiente' &&
          b.fecha === todayCancun && isWithinOneHour(b.fecha, b.hora, nowMs));
        const pendienteWelcome = !enServicio && welcomes.find(w =>
          w.driverId === d.id && w.estatusViaje === 'pendiente' &&
          w.fecha === todayCancun && isWithinOneHour(w.fecha, w.hora, nowMs));
        const proximos = pendienteBooking || pendienteWelcome;

        // 3. INFO DE CHECADA HOY: primera ENTRADA del driver hoy
        const entradasDriver = checadasHoy
          .filter(c => c.driverId === d.id && c.tipo === 'ENTRADA')
          .sort((a,b) => (a.creadoEn||'').localeCompare(b.creadoEn||''));
        const primeraEntrada = entradasDriver.length ? entradasDriver[0] : null;
        const checadaHoraEntrada = primeraEntrada ? primeraEntrada.creadoEn : null;
        const noHaChecado = !primeraEntrada;

        let estado = 'disponible';
        let minutos = null;
        let refId = null, destino = null;

        if (enServicio) {
          estado = 'en-servicio';
          if (enServicio.serviceStartTime)
            minutos = Math.floor((nowMs - new Date(enServicio.serviceStartTime).getTime()) / 60000);
          refId   = enServicio.bookingId || enServicio.welcomeId || null;
          destino = enServicio.destino || null;
        } else if (proximos) {
          estado  = 'pendiente';
          refId   = proximos.bookingId || proximos.welcomeId || null;
          destino = proximos.destino || null;
        } else if (d.manualEstado) {
          // Override manual (solo aplica si no hay estado natural)
          estado = d.manualEstado;
        } else if (noHaChecado) {
          // Sin checada de entrada hoy
          estado = 'no-checado';
        }

        return { id:d.id, nombre:d.nombre, estado, minutos, refId, destino, checadaHoraEntrada, noHaChecado };
      });
      return json(res, result);
    }

    // PUT /api/drivers/:id/estado — override manual de estado (solo admins/coordinador)
    const driverEstadoMatch = pathname.match(/^\/api\/drivers\/([^/]+)\/estado$/);
    if (driverEstadoMatch && method === 'PUT') {
      if (!['admin_unico','admin','coordinador'].includes(rol)) return err(res, 'Sin permiso', 403);
      const data  = readData();
      const uIdx  = data.users.findIndex(u => u.id === driverEstadoMatch[1] && u.rol === 'driver');
      if (uIdx === -1) return err(res, 'Driver no encontrado', 404);
      const nuevoEstado = body.manualEstado || null; // null = limpiar override
      data.users[uIdx] = { ...data.users[uIdx], manualEstado: nuevoEstado };
      writeData(data);
      return json(res, { ok:true, manualEstado: nuevoEstado });
    }

    // POST /api/drivers/me/disponible — el driver se marca disponible (Ya en el Hotel)
    if (pathname === '/api/drivers/me/disponible' && method === 'POST') {
      if (rol !== 'driver') return err(res, 'Sin permiso', 403);
      const data = readData();
      const uIdx = data.users.findIndex(u => u.id === sess.userId);
      if (uIdx === -1) return err(res, 'Driver no encontrado', 404);
      data.users[uIdx] = { ...data.users[uIdx], manualEstado: 'disponible' };
      writeData(data);
      return json(res, { ok:true, manualEstado: 'disponible' });
    }

    // GET /api/conductores (compatibilidad — devuelve drivers)
    if (pathname === '/api/conductores' && method === 'GET') {
      const data = readData();
      return json(res, data.users.filter(u => u.rol === 'driver').map(u => ({ id:u.id, nombre:u.nombre })));
    }

    // ── WELCOME CRUD ─────────────────────────────────────────
    const WELCOME_ROLES = ['admin_unico', 'admin', 'coordinador'];
    function enrichWelcome(w, data) {
      const d = data.users.find(u => u.id === w.driverId);
      return { ...w, driverNombre: d ? d.nombre : 'Sin asignar' };
    }

    // GET /api/welcomes
    if (pathname === '/api/welcomes' && method === 'GET') {
      if (!WELCOME_ROLES.includes(rol) && rol !== 'driver')
        return err(res, 'Sin permiso', 403);
      const data = readData();
      let list = [...(data.welcomes || [])];
      if (rol === 'driver') list = list.filter(w => w.driverId === sess.userId);
      if (query.fecha) list = list.filter(w => w.fecha === query.fecha);
      if (query.mes)   list = list.filter(w => w.fecha?.startsWith(query.mes));
      list.sort((a, b) => {
        const da = new Date(`${a.fecha}T${a.hora||'00:00'}`);
        const db = new Date(`${b.fecha}T${b.hora||'00:00'}`);
        return da - db;
      });
      return json(res, list.map(w => enrichWelcome(w, data)));
    }

    // GET /api/welcomes/:id
    const wmatch = pathname.match(/^\/api\/welcomes\/([^/]+)$/);
    if (wmatch && method === 'GET') {
      const data = readData();
      const w = (data.welcomes || []).find(w => w.id === wmatch[1]);
      if (!w) return err(res, 'Welcome no encontrado', 404);
      if (rol === 'driver' && w.driverId !== sess.userId) return err(res, 'Sin permiso', 403);
      return json(res, enrichWelcome(w, data));
    }

    // POST /api/welcomes
    if (pathname === '/api/welcomes' && method === 'POST') {
      if (!WELCOME_ROLES.includes(rol)) return err(res, 'Sin permiso', 403);
      const data = readData();
      if (typeof data.welcomeCounter !== 'number') data.welcomeCounter = 0;
      data.welcomeCounter += 1;
      const welcomeId = 'W' + String(data.welcomeCounter).padStart(4, '0');
      if (!body.nombre) return err(res, 'El nombre es requerido');
      const welcome = {
        id:               uid(),
        welcomeId,
        nombre:           body.nombre           || '',
        fecha:            body.fecha             || cancunDateStr(),
        numeroInvitacion: body.numeroInvitacion  || '',
        destino:          body.destino           || '',
        costo:            parseFloat(body.costo) || 0,
        driverId:         body.driverId          || '',
        hora:             body.hora              || '',
        folio:            body.folio             || '',
        estatusViaje:     'pendiente',
        serviceStartTime: null,
        serviceEndTime:   null,
        creadoPor:        sess.userId,
        creadoEn:         new Date().toISOString()
      };
      if (!data.welcomes) data.welcomes = [];
      data.welcomes.push(welcome);
      writeData(data);
      return json(res, enrichWelcome(welcome, data), 201);
    }

    // PUT /api/welcomes/:id
    if (wmatch && method === 'PUT') {
      if (!WELCOME_ROLES.includes(rol) && rol !== 'driver') return err(res, 'Sin permiso', 403);
      const data = readData();
      const idx  = (data.welcomes || []).findIndex(w => w.id === wmatch[1]);
      if (idx === -1) return err(res, 'Welcome no encontrado', 404);
      const prev = data.welcomes[idx];
      if (rol === 'driver' && prev.driverId !== sess.userId) return err(res, 'Sin permiso', 403);

      let updates;
      if (rol === 'driver') {
        // Driver solo actualiza estatus
        updates = { ...prev, estatusViaje: body.estatusViaje ?? prev.estatusViaje };
      } else {
        updates = {
          ...prev,
          nombre:           body.nombre           ?? prev.nombre,
          fecha:            body.fecha             ?? prev.fecha,
          numeroInvitacion: body.numeroInvitacion  ?? prev.numeroInvitacion,
          destino:          body.destino           ?? prev.destino,
          costo:            body.costo !== undefined ? parseFloat(body.costo) : prev.costo,
          driverId:         body.driverId          ?? prev.driverId,
          hora:             body.hora              ?? prev.hora,
          folio:            body.folio             ?? prev.folio,
          estatusViaje:     body.estatusViaje      ?? prev.estatusViaje,
        };
      }
      if (body.estatusViaje === 'en-camino')  updates.serviceStartTime = new Date().toISOString();
      if (body.estatusViaje === 'completado') updates.serviceEndTime   = new Date().toISOString();
      data.welcomes[idx] = updates;
      writeData(data);
      return json(res, enrichWelcome(updates, data));
    }

    // DELETE /api/welcomes/:id — solo admin_unico
    if (wmatch && method === 'DELETE') {
      if (rol !== 'admin_unico') return err(res, 'Sin permiso', 403);
      const data = readData();
      const idx  = (data.welcomes || []).findIndex(w => w.id === wmatch[1]);
      if (idx === -1) return err(res, 'Welcome no encontrado', 404);
      data.welcomes.splice(idx, 1);
      writeData(data);
      return json(res, { ok:true });
    }

    // POST /api/users — solo admin_unico puede crear usuarios
    if (pathname === '/api/users' && method === 'POST') {
      if (rol !== 'admin_unico') return err(res, 'Solo la Cuenta Maestra puede crear usuarios', 403);
      const { username, password, nombre, rol: newRol } = body;
      if (!username || !password || !nombre || !newRol) return err(res, 'Todos los campos son requeridos');
      if (newRol === 'admin_unico') return err(res, 'No se puede crear otro usuario con el rol de Cuenta Maestra', 403);
      const data = readData();
      if (data.users.find(u => u.username === username)) return err(res, 'El usuario ya existe');
      const user = { id:uid(), username, password:sha(password), nombre, rol:newRol };
      data.users.push(user);
      writeData(data);
      return json(res, { id:user.id, username:user.username, nombre:user.nombre, rol:user.rol }, 201);
    }

    // PUT /api/users/:id — solo admin_unico puede editar usuarios
    const umatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (umatch && method === 'PUT') {
      if (rol !== 'admin_unico') return err(res, 'Solo la Cuenta Maestra puede editar usuarios', 403);
      const data = readData();
      const idx  = data.users.findIndex(u => u.id === umatch[1]);
      if (idx === -1) return err(res, 'Usuario no encontrado', 404);
      const { nombre, rol: newRol, password: newPass, username: newUser } = body;
      if (newUser && newUser !== data.users[idx].username && data.users.find(u => u.username === newUser))
        return err(res, 'El usuario ya está en uso');
      // admin NO puede cambiar contraseñas
      if (rol === 'admin' && newPass) return err(res, 'No tienes permiso para cambiar contraseñas', 403);
      // Proteger Cuenta Maestra: su rol no puede cambiar, y no se puede asignar ese rol a otro usuario
      if (data.users[idx].rol === 'admin_unico' && newRol && newRol !== 'admin_unico')
        return err(res, 'El rol de la Cuenta Maestra no puede modificarse', 403);
      if (newRol === 'admin_unico' && data.users[idx].rol !== 'admin_unico')
        return err(res, 'No se puede asignar el rol de Cuenta Maestra a otro usuario', 403);
      data.users[idx] = {
        ...data.users[idx],
        ...(nombre  && { nombre }),
        ...(newRol  && { rol: newRol }),
        ...(newUser && { username: newUser }),
        ...(newPass && rol === 'admin_unico' && { password: sha(newPass) })
      };
      writeData(data);
      const u = data.users[idx];
      return json(res, { id:u.id, username:u.username, nombre:u.nombre, rol:u.rol });
    }

    // DELETE /api/users/:id — solo admin_unico
    if (umatch && method === 'DELETE') {
      if (rol !== 'admin_unico') return err(res, 'Solo la Cuenta Maestra puede eliminar usuarios', 403);
      if (umatch[1] === sess.userId) return err(res, 'No puedes eliminar tu propio usuario');
      const data = readData();
      const idx  = data.users.findIndex(u => u.id === umatch[1]);
      if (idx === -1) return err(res, 'Usuario no encontrado', 404);
      data.users.splice(idx, 1);
      writeData(data);
      return json(res, { ok:true });
    }

    // GET /api/vehicles
    if (pathname === '/api/vehicles' && method === 'GET') {
      const data = readData();
      return json(res, data.vehicles);
    }

    // PUT /api/vehicles/:id
    const vmatch = pathname.match(/^\/api\/vehicles\/([^/]+)$/);
    if (vmatch && method === 'PUT') {
      if (!ADMIN_ROLES.includes(rol)) return err(res, 'Sin permiso', 403);
      const data = readData();
      const idx  = data.vehicles.findIndex(v => v.id === vmatch[1]);
      if (idx === -1) return err(res, 'Vehículo no encontrado', 404);
      data.vehicles[idx] = { ...data.vehicles[idx], ...body, id: vmatch[1] };
      writeData(data);
      return json(res, data.vehicles[idx]);
    }

    // ── RELOJ CHECADOR ────────────────────────────────────────

    // GET /api/checadas/config — devuelve la ubicación esperada
    if (pathname === '/api/checadas/config' && method === 'GET') {
      return json(res, {
        lat:       EXPECTED_LAT,
        lng:       EXPECTED_LNG,
        radiusKm:  EXPECTED_RADIUS_KM,
        nombre:    EXPECTED_LOCATION_NAME
      });
    }

    // POST /api/checadas — registrar entrada/salida (driver, coordinador, asesor)
    if (pathname === '/api/checadas' && method === 'POST') {
      if (!['driver','coordinador','asesor'].includes(rol)) return err(res, 'Sin permiso', 403);

      // ── 1. GPS REQUERIDO ─────────────────────────────────────
      const ckLat = typeof body.lat === 'number' ? body.lat : null;
      const ckLng = typeof body.lng === 'number' ? body.lng : null;
      if (ckLat === null || ckLng === null) {
        return err(res, 'Se requiere ubicación GPS para registrar la checada. Activa la ubicación en tu dispositivo.', 400);
      }

      const data = readData();
      if (!Array.isArray(data.checadas)) data.checadas = [];

      // ── 2. BLOQUEAR DOBLE ENTRADA ────────────────────────────
      const tipoSolicitado = body.tipo === 'SALIDA' ? 'SALIDA' : 'ENTRADA';
      const todayFecha = cancunDateStr(); // YYYY-MM-DD en zona Cancún
      const checadasHoyDriver = data.checadas
        .filter(c => c.driverId === sess.userId && c.fecha === todayFecha)
        .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
      const ultimaTipo = checadasHoyDriver.length ? checadasHoyDriver[0].tipo : null;

      if (tipoSolicitado === 'ENTRADA' && ultimaTipo === 'ENTRADA') {
        return err(res, 'Ya tienes una ENTRADA activa hoy. Registra tu SALIDA primero.', 409);
      }
      if (tipoSolicitado === 'SALIDA' && ultimaTipo !== 'ENTRADA') {
        return err(res, 'No tienes una ENTRADA activa hoy para registrar SALIDA.', 409);
      }

      // ── 3. CAPTURAR IP ───────────────────────────────────────
      const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket?.remoteAddress
                  || 'desconocida';
      const clientIp = rawIp.replace(/^::ffff:/, '');

      // ── 4. DETECTAR BUDDY PUNCH (misma IP, distinto driver, últimos 10 min) ──
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const alertaBuddyPunch = data.checadas.some(c =>
        c.ip === clientIp &&
        c.driverId !== sess.userId &&
        c.creadoEn >= tenMinAgo
      );

      // ── 5. CALCULAR DISTANCIA Y VALIDACIÓN ──────────────────
      const distanciaKm   = haversineKm(ckLat, ckLng, EXPECTED_LAT, EXPECTED_LNG);
      const dentroDeZona  = distanciaKm <= EXPECTED_RADIUS_KM;
      const validacionEstado = dentroDeZona ? 'valida' : 'fuera_de_zona';

      // ── 6. CONSTRUIR Y GUARDAR ───────────────────────────────
      if (typeof data.checadaCounter !== 'number') data.checadaCounter = 0;
      data.checadaCounter += 1;

      const user      = data.users.find(u => u.id === sess.userId);
      const cancunNow = new Intl.DateTimeFormat('es-MX', {
        timeZone: 'America/Cancun',
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
      }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

      const checada = {
        id:              `CH${String(data.checadaCounter).padStart(4,'0')}`,
        driverId:        sess.userId,
        nombre:          user ? user.nombre : 'Desconocido',
        tipo:            tipoSolicitado,
        fecha:           todayFecha,
        hora:            `${cancunNow.hour}:${cancunNow.minute}:${cancunNow.second}`,
        ip:              clientIp,
        lat:             ckLat,
        lng:             ckLng,
        locationStr:     body.locationStr || null,
        accuracy:        typeof body.accuracy === 'number' ? body.accuracy : null,
        distanciaKm:     Math.round(distanciaKm * 1000) / 1000,
        dentroDeZona,
        validacionEstado,
        alertaBuddyPunch,
        creadoEn:        new Date().toISOString()
      };

      data.checadas.push(checada);
      writeData(data);
      return json(res, checada, 201);
    }

    // GET /api/checadas — historial de checadas (admin/admin_unico ven todo; driver/coordinador/asesor ven los suyos)
    if (pathname === '/api/checadas' && method === 'GET') {
      const HR_ROLES = ['admin_unico','admin'];
      const STAFF_CHECKER_ROLES = ['driver','coordinador','asesor'];
      if (!HR_ROLES.includes(rol) && !STAFF_CHECKER_ROLES.includes(rol)) return err(res, 'Sin permiso', 403);
      const data = readData();
      let lista = data.checadas || [];
      if (STAFF_CHECKER_ROLES.includes(rol)) lista = lista.filter(c => c.driverId === sess.userId);
      // Ordenar más reciente primero
      lista = [...lista].sort((a,b) => b.creadoEn.localeCompare(a.creadoEn));
      return json(res, lista);
    }

    // GET /api/stats — solo admin_unico y admin
    if (pathname === '/api/stats' && method === 'GET') {
      if (!STATS_ROLES.includes(rol)) return err(res, 'Sin permiso', 403);
      const data     = readData();
      const bookings = data.bookings;
      const welcomes = data.welcomes || [];
      const now      = new Date();
      const todayStr = cancunDateStr(now);
      const weekStr  = cancunMondayStr(now);
      const monthStr = todayStr.substring(0, 7) + '-01';

      // Helpers de suma para bookings (precio) y welcomes (costo)
      const sumB = arr => arr.reduce((s,b) => s + (parseFloat(b.precio)||0), 0);
      const sumW = arr => arr.reduce((s,w) => s + (parseFloat(w.costo) ||0), 0);

      // Ventas de hoy: bookings + welcomes con fecha = hoy
      const todayB = bookings.filter(b => b.fecha === todayStr);
      const todayW = welcomes.filter(w => w.fecha === todayStr);

      // Esta semana
      const weekB  = bookings.filter(b => b.fecha >= weekStr);
      const weekW  = welcomes.filter(w => w.fecha >= weekStr);

      // Este mes
      const monthB = bookings.filter(b => b.fecha >= monthStr);
      const monthW = welcomes.filter(w => w.fecha >= monthStr);

      // Transacciones de hoy: CREADAS hoy (por fecha de creación)
      const transHoyB = bookings.filter(b => b.creadoEn && cancunDateStr(new Date(b.creadoEn)) === todayStr);
      const transHoyW = welcomes.filter(w => w.creadoEn && cancunDateStr(new Date(w.creadoEn)) === todayStr);

      // Comparación semanal por unidad de negocio (HXM, HXM II, HXA, WELCOME)
      const weekly = [0, 1, 2, 3].map(weeksAgo => {
        const range    = cancunWeekRange(weeksAgo, now);
        const wBks     = bookings.filter(b => b.fecha >= range.start && b.fecha <= range.end);
        const wWels    = welcomes.filter(w => w.fecha >= range.start && w.fecha <= range.end);
        const labels   = ['Esta semana', 'Semana pasada', 'Hace 2 semanas', 'Hace 3 semanas'];
        return {
          label:   labels[weeksAgo],
          start:   range.start,
          end:     range.end,
          hxm:     sumB(wBks.filter(b => b.origenTipo === 'HXM')),
          hxm2:    sumB(wBks.filter(b => b.origenTipo === 'HXM II')),
          hxa:     sumB(wBks.filter(b => b.origenTipo === 'HXA')),
          welcome: sumW(wWels),
          total:   sumB(wBks) + sumW(wWels),
          viajes:  wBks.length + wWels.length
        };
      });

      // Comparación mensual por unidad
      const monthly = {
        hxm:     sumB(monthB.filter(b => b.origenTipo === 'HXM')),
        hxm2:    sumB(monthB.filter(b => b.origenTipo === 'HXM II')),
        hxa:     sumB(monthB.filter(b => b.origenTipo === 'HXA')),
        welcome: sumW(monthW),
      };

      const byDriver = {}, byDestino = {};
      bookings.forEach(b => {
        const u  = data.users.find(u => u.id === b.driverId);
        const kd = u ? u.nombre : 'Sin asignar';
        if (!byDriver[kd]) byDriver[kd] = { nombre:kd, total:0, viajes:0 };
        byDriver[kd].total  += parseFloat(b.precio)||0;
        byDriver[kd].viajes += 1;
        const kdes = b.destino || 'Sin destino';
        if (!byDestino[kdes]) byDestino[kdes] = { destino:kdes, total:0, viajes:0 };
        byDestino[kdes].total  += parseFloat(b.precio)||0;
        byDestino[kdes].viajes += 1;
      });
      welcomes.forEach(w => {
        const u  = data.users.find(u => u.id === w.driverId);
        const kd = u ? u.nombre : 'Sin asignar';
        if (!byDriver[kd]) byDriver[kd] = { nombre:kd, total:0, viajes:0 };
        byDriver[kd].total  += parseFloat(w.costo)||0;
        byDriver[kd].viajes += 1;
      });

      return json(res, {
        resumen: {
          hoy:             { viajes: todayB.length + todayW.length,
                             ingresos: sumB(todayB) + sumW(todayW) },
          semana:          { viajes: weekB.length + weekW.length,
                             ingresos: sumB(weekB) + sumW(weekW) },
          mes:             { viajes: monthB.length + monthW.length,
                             ingresos: sumB(monthB) + sumW(monthW) },
          transaccionesHoy:{ viajes: transHoyB.length + transHoyW.length,
                             ingresos: sumB(transHoyB) + sumW(transHoyW) },
        },
        estatus: {
          pendiente:   bookings.filter(b=>b.estatusViaje==='pendiente').length,
          'en-camino': bookings.filter(b=>b.estatusViaje==='en-camino').length,
          completado:  bookings.filter(b=>b.estatusViaje==='completado').length,
          'no-show':   bookings.filter(b=>b.estatusViaje==='no-show').length
        },
        weekly,
        monthly,
        byDriver:  Object.values(byDriver).sort((a,b) => b.total-a.total),
        byDestino: Object.values(byDestino).sort((a,b) => b.total-a.total).slice(0,10)
      });
    }

    err(res, 'Ruta no encontrada', 404);

  } catch(e) {
    console.error(e);
    err(res, 'Error del servidor', 500);
  }
});

// ─── AUTO-CIERRE DIARIO DE SERVICIOS (08:50 AM Cancún) ──────────────────────
function autoClosePreviousDayServices() {
  const data = readData();
  const todayCancun = cancunDateStr();
  let changed = false;

  // Cerrar bookings de días anteriores que sigan pendientes o en-camino
  data.bookings.forEach((b, i) => {
    if (b.fecha < todayCancun && (b.estatusViaje === 'pendiente' || b.estatusViaje === 'en-camino')) {
      data.bookings[i] = { ...b, estatusViaje: 'completado', serviceEndTime: new Date().toISOString() };
      changed = true;
    }
  });

  // Cerrar welcomes de días anteriores
  if (data.welcomes) {
    data.welcomes.forEach((w, i) => {
      if (w.fecha < todayCancun && (w.estatusViaje === 'pendiente' || w.estatusViaje === 'en-camino')) {
        data.welcomes[i] = { ...w, estatusViaje: 'completado', serviceEndTime: new Date().toISOString() };
        changed = true;
      }
    });
  }

  if (changed) {
    writeData(data);
    console.log(`[auto-cierre] ✅ Servicios de días anteriores cerrados automáticamente (${new Date().toISOString()})`);
  }
}

// Programar auto-cierre a las 08:50 AM Cancún cada día
function scheduleAutoCierre() {
  function getNextRun() {
    const now = new Date();
    const todayStr = cancunDateStr(now);
    let target = Date.parse(`${todayStr}T08:50:00-05:00`);
    if (isNaN(target) || target <= now.getTime()) {
      // Si ya pasó hoy, programar para mañana
      const tomorrowMs = now.getTime() + 86400000;
      const tomorrowStr = cancunDateStr(new Date(tomorrowMs));
      target = Date.parse(`${tomorrowStr}T08:50:00-05:00`);
    }
    return target - now.getTime();
  }

  function runAndReschedule() {
    try { autoClosePreviousDayServices(); } catch (e) { console.error('[auto-cierre] Error:', e.message); }
    setTimeout(runAndReschedule, getNextRun());
  }

  setTimeout(runAndReschedule, getNextRun());
  console.log('[auto-cierre] ⏰ Programado para las 08:50 AM Cancún cada día');

  // También ejecutar al inicio si hay servicios de días anteriores que cerrar
  try { autoClosePreviousDayServices(); } catch (e) { console.error('[auto-cierre] Error inicial:', e.message); }
}

// ─── START ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  🚗  XOTICS — Reservaciones  v2          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n   ➜  http://localhost:${PORT}\n`);
  console.log('   Credenciales (todas: Xotics2026)');
  console.log('   admin       → Administrador Único');
  console.log('   admin2      → Administrador');
  console.log('   coordinador → Coordinador');
  console.log('   asesor      → Asesor de Ventas');
  console.log('   driver1     → Driver\n');
  scheduleAutoCierre();
});
