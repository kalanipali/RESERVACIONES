// ============================================================
// XOTICS TRANSPORTATION — Sistema de Reservaciones v2
// server.js — Sin dependencias externas (solo Node.js nativo)
// ============================================================

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC    = path.join(__dirname, 'public');

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
    welcomes: []
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
function enrich(b, data) {
  const v = data.vehicles.find(v => v.id === b.vehiculoId);
  const c = data.users.find(u => u.id === b.driverId);
  return {
    ...b,
    vehiculoNombre: v ? v.nombre : 'Sin vehículo',
    driverNombre:   c ? c.nombre : 'Sin asignar'
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
        destino:         body.destino          || '',
        fecha:           body.fecha            || '',
        hora:            body.hora             || '',
        pasajeros:       parseInt(body.pasajeros)  || 1,
        numeroVuelo:     body.numeroVuelo      || '',
        vehiculoId:      CAN_ASSIGN.includes(rol) ? (body.vehiculoId || '') : '',
        driverId:        CAN_ASSIGN.includes(rol) ? (body.driverId   || '') : '',
        precio:          parseFloat(body.precio)   || 0,
        horas:           parseInt(body.horas)      || 0,
        metodoPago:      body.metodoPago       || '',
        estatusPago:     body.estatusPago      || 'pendiente',
        estatusViaje:    'pendiente',
        serviceStartTime: null,
        notas:           body.notas            || '',
        creadoPor:       sess.userId,
        creadoEn:        new Date().toISOString()
      };
      data.bookings.push(booking);
      writeData(data);
      return json(res, enrich(booking, data), 201);
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
          vehiculoId: CAN_ASSIGN.includes(rol) ? (body.vehiculoId ?? prev.vehiculoId) : prev.vehiculoId,
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
        }

        return { id:d.id, nombre:d.nombre, estado, minutos, refId, destino };
      });
      return json(res, result);
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

    // PUT /api/users/:id
    const umatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (umatch && method === 'PUT') {
      if (!ADMIN_ROLES.includes(rol)) return err(res, 'Sin permiso', 403);
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
});
