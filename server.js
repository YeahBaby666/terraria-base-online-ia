const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const vm = require("vm");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const nodeFetch = require("node-fetch"); // Usaremos 'node-fetch' para las llamadas internas API si es necesario

// ====================================================================
// --- CONFIGURACIÓN DE ACCESO Y VARIABLES DE ENTORNO ---
// ====================================================================

// Base URL para los endpoints de la API de este servidor Node.js
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";

// Configuración de Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || "SUPABASE_URL";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "SUPABASE_KEY";

// Configuración de Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "GEMINI_API_KEY";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Inicializar Express para manejar la API HTTP (Publicación)
const app = express();
// --- CORRECCIÓN CLAVE: Configurar CORS para la API ---
app.use(
  cors({
    origin: "*", // En producción, cámbialo a la URL de tu app de Spring Boot en Render
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(bodyParser.json());
const PORT = process.env.PORT || 3000; // Render establece process.env.PORT automáticamente

const httpServer = app.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP/API y Sockets iniciado en puerto ${PORT}`);
});

const io = new Server(httpServer, { cors: { origin: "*" } });
const rooms = {}; // Memoria: { 'id': { state, logic, bots:[], players:Set, ownerId, interval } }

// ... (Tus imports: express, vm, socket.io, supabase, etc. siguen igual arriba) ...

// ====================================================================
// --- 1. MOTORES DEL NÚCLEO (CLASSES) ---
// ====================================================================
/** * 7. RENDER CORE: Gestor de Vista y Optimización de Red
 * Se encarga de transformar el Estado Lógico en un Estado Visual ligero.
 */
class RenderCore {
  constructor() {
    this.configs = new Map(); // Reglas de renderizado por tipo
    this.globals = {}; // Datos globales (Score, UI)
    this.rounding = 2; // Precisión decimal (2 = 10.55, ahorra bytes)
  }

  /**
   * Define cómo se debe renderizar una entidad
   * @param {string} type - Tipo de entidad ('Zombie')
   * @param {Object} config - Reglas { sprite, props, logic }
   */
  setup(type, config) {
    this.configs.set(type, {
      sprite: "default", // Sprite por defecto
      props: ["x", "y"], // Propiedades a copiar automáticamente
      map: null, // Función para calcular propiedades visuales
      ...config,
    });
  }

  /**
   * Actualiza datos globales de UI
   */
  setGlobal(key, value) {
    this.globals[key] = value;
  }

  /**
   * MÁQUINA DE OPTIMIZACIÓN
   * Genera el snapshot final recorriendo las entidades activas
   */
  processSnapshot(activeEntities, effects) {
    const entitiesPacket = [];

    // 1. Procesar Entidades
    for (const entry of activeEntities) {
      const ent = entry.data;
      const config = this.configs.get(ent._type);

      // Si no hay config, NO se renderiza (es invisible/lógico)
      if (!config) continue;

      // A. Objeto base optimizado
      const visual = {
        id: ent.id,
        t: config.sprite, // 't' es más corto que 'type' (ahorra red)
      };

      // B. Copiado Automático de Propiedades (Whitelist)
      for (const prop of config.props) {
        let val = ent[prop];
        // Redondeo automático de números para comprimir JSON
        if (typeof val === "number") {
          visual[prop] = Number(val.toFixed(this.rounding));
        } else {
          visual[prop] = val;
        }
      }

      // C. Mapeo Lógico -> Visual (Computed Properties)
      // Ej: Calcular % de barra de vida
      if (config.map) {
        const computed = config.map(ent);
        Object.assign(visual, computed);
      }

      entitiesPacket.push(visual);
    }

    // 2. Empaquetar todo
    return {
      g: this.globals, // Globals
      e: entitiesPacket, // Entidades
      fx: effects, // Efectos
    };
  }
}
/** PHYSICS CORE: Motor Físico Puro */
const PhysicsCore = {
  overlaps: (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
  containsPoint: (box, x, y) =>
    x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h,

  // Mueve un grupo de entidades contra un universo
  updateGroup: function (entities, universe, dt, globalGravity = 300) {
    for (let i = 0; i < entities.length; i++) {
      const ent = entities[i];

      // Fuerzas
      if (ent.gravityScale !== 0) {
        const g =
          (ent.gravityScale !== undefined ? ent.gravityScale : 1) *
          globalGravity;
        ent.vy = (ent.vy || 0) + g * dt;
      }
      if (ent.friction) ent.vx *= ent.friction;

      let nextX = ent.x + (ent.vx || 0) * dt;
      let nextY = ent.y + (ent.vy || 0) * dt;
      ent.onGround = false;

      // Optimización Espacial
      const candidates = universe.getNearby
        ? universe.getNearby({ x: nextX, y: nextY, w: ent.w, h: ent.h })
        : Array.isArray(universe)
        ? universe
        : [];

      for (const other of candidates) {
        if (other === ent || other.noClip) continue;
        // X Axis
        if (
          nextX < other.x + other.w &&
          nextX + ent.w > other.x &&
          ent.y < other.y + other.h &&
          ent.y + ent.h > other.y
        ) {
          if (ent.restitution) {
            ent.vx = -ent.vx * ent.restitution;
            nextX = ent.x;
          } else {
            nextX = ent.vx > 0 ? other.x - ent.w : other.x + other.w;
            ent.vx = 0;
          }
        }
        // Y Axis
        if (
          nextX < other.x + other.w &&
          nextX + ent.w > other.x &&
          nextY < other.y + other.h &&
          nextY + ent.h > other.y
        ) {
          if (ent.vy > 0 && ent.y + ent.h <= other.y) {
            nextY = other.y - ent.h;
            if (ent.restitution && Math.abs(ent.vy) > 40)
              ent.vy = -ent.vy * ent.restitution;
            else {
              ent.vy = 0;
              ent.onGround = true;
            }
          } else if (ent.vy < 0 && ent.y >= other.y + other.h) {
            nextY = other.y + other.h;
            ent.vy = 0;
          }
        }
      }
      ent.x = nextX;
      ent.y = nextY;
    }
  },

  // Colisiones Grupo vs Grupo
  collideGroups: function (projectiles, targets, onHitCallback) {
    const tempSpace = new UniverseCore(100);
    for (const t of targets) tempSpace.add(t);
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const nearby = tempSpace.getNearby(p);
      for (const t of nearby) {
        if (this.overlaps(p, t)) {
          if (!onHitCallback(p, t)) {
            projectiles.splice(i, 1);
            break;
          }
        }
      }
    }
  },
};

/** UNIVERSE CORE: Spatial Hash Grid (Optimización) */
class UniverseCore {
  constructor(cellSize = 100) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }
  add(obj) {
    const sx = Math.floor(obj.x / this.cellSize),
      ex = Math.floor((obj.x + obj.w) / this.cellSize);
    const sy = Math.floor(obj.y / this.cellSize),
      ey = Math.floor((obj.y + obj.h) / this.cellSize);
    for (let x = sx; x <= ex; x++)
      for (let y = sy; y <= ey; y++) {
        const k = `${x},${y}`;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(obj);
      }
  }
  clear() {
    this.grid.clear();
  }
  getNearby(ent) {
    return this.query(ent.x, ent.y, ent.w, ent.h);
  }
  query(x, y, w, h) {
    const res = new Set(),
      sx = Math.floor(x / this.cellSize),
      ex = Math.floor((x + w) / this.cellSize),
      sy = Math.floor(y / this.cellSize),
      ey = Math.floor((y + h) / this.cellSize);
    for (let c = sx; c <= ex; c++)
      for (let r = sy; r <= ey; r++) {
        const cell = this.grid.get(`${c},${r}`);
        if (cell) for (const o of cell) res.add(o);
      }
    return res;
  }
  queryRadius(x, y, r) {
    const cand = this.query(x - r, y - r, r * 2, r * 2),
      res = [],
      r2 = r * r;
    for (const o of cand) {
      if ((o.x + o.w / 2 - x) ** 2 + (o.y + o.h / 2 - y) ** 2 <= r2)
        res.push(o);
    }
    return res;
  }
}

/** SCHEDULER CORE: Timers (Timer.every) */
class SchedulerCore {
  constructor() {
    this.tasks = [];
  }
  wait(sec, cb) {
    this.tasks.push({ time: sec, max: sec, cb, loop: false });
  }
  every(sec, cb) {
    this.tasks.push({ time: sec, max: sec, cb, loop: true });
  }
  update(dt) {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const t = this.tasks[i];
      t.time -= dt;
      if (t.time <= 0) {
        try {
          t.cb();
        } catch (e) {
          console.error("Timer Error:", e);
        }
        if (t.loop) t.time = t.max;
        else this.tasks.splice(i, 1);
      }
    }
  }
}

/** SIGNAL CORE: Event Bus */
class SignalCore {
  constructor() {
    this.listeners = new Map();
  }
  on(evt, cb) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, []);
    this.listeners.get(evt).push(cb);
  }
  emit(evt, data) {
    const cbs = this.listeners.get(evt);
    if (cbs)
      for (const cb of cbs)
        try {
          cb(data);
        } catch (e) {
          console.error(e);
        }
  }
}

/** ENTITY CORE: Sistema de Actores (OOP Explícito) */
class EntityCore {
  constructor(signalEngine) {
    this.blueprints = new Map();
    this.activeEntities = [];
    this.signalEngine = signalEngine;
  }

  define(name, schema) {
    const template = {
      group: "default",
      vars: {},
      onCreate: (self) => {},
      onUpdate: (self, dt) => {},
      onCollide: (self, other) => true,
      onInput: (self, input) => {},
      onSignal: (self, event, data) => {}, // Nuevo: Escucha explícita
      ...schema,
    };
    this.blueprints.set(name, template);
  }

  create(name, x, y, customVars = {}, state) {
    const bp = this.blueprints.get(name);
    if (!bp) return null;
    const id = name + "_" + Math.random().toString(36).substr(2, 6);

    const entity = {
      id,
      x,
      y,
      w: 40,
      h: 40,
      vx: 0,
      vy: 0,
      _type: name,
      ...JSON.parse(JSON.stringify(bp.vars)),
      ...customVars,
      // Emisión explícita inyectada
      emit: (event, data = {}) =>
        this.signalEngine.emit(event, {
          ...data,
          senderId: id,
          senderType: name,
        }),
    };

    const g = bp.group;
    if (!state[g]) state[g] = Array.isArray(state[g]) ? [] : {};
    if (Array.isArray(state[g])) state[g].push(entity);
    else state[g][id] = entity;

    if (bp.onCreate) bp.onCreate(entity);
    this.activeEntities.push({ data: entity, behavior: bp });
    return entity;
  }

  processLogic(dt, gameContext) {
    for (let i = this.activeEntities.length - 1; i >= 0; i--) {
      const e = this.activeEntities[i];
      if (e.data._destroyed) {
        this.activeEntities.splice(i, 1);
        continue;
      } // Limpieza simple
      if (e.behavior.onUpdate)
        try {
          e.behavior.onUpdate(e.data, dt, gameContext);
        } catch (err) {
          console.error(err);
        }
    }
  }

  dispatchInput(id, input) {
    const e = this.activeEntities.find((ent) => ent.data.id === id);
    if (e && e.behavior.onInput) e.behavior.onInput(e.data, input);
  }

  dispatchSignal(event, data) {
    for (const e of this.activeEntities) {
      if (e.behavior.onSignal) e.behavior.onSignal(e.data, event, data);
    }
  }

  /**
   * Genera la lista limpia de entidades para enviar al cliente
   */
  getSnapshot() {
    const snapshot = [];

    for (const entry of this.activeEntities) {
      const { data, behavior } = entry;

      // 1. Si el Actor tiene un método 'onSync' explícito, úsalo
      if (behavior.onSync) {
        const visualData = behavior.onSync(data);
        // Inyectamos ID y Tipo obligatoriamente para que el cliente sepa qué es
        if (visualData) {
          visualData.id = data.id;
          visualData.type = data._type; // Nombre de la clase (ej: 'Zombie')
          visualData.x = visualData.x ?? data.x; // Fallback x
          visualData.y = visualData.y ?? data.y; // Fallback y
          snapshot.push(visualData);
        }
      }
      // 2. Si no tiene 'onSync', enviamos un default seguro (posición y tamaño)
      else {
        snapshot.push({
          id: data.id,
          type: data._type,
          x: data.x,
          y: data.y,
          w: data.w,
          h: data.h,
          // No enviamos vars internas ni HP oculto
        });
      }
    }
    return snapshot;
  }
}

/** FX HELPER: Efectos Visuales */
const createFXContext = (state) => ({
  spawn: (type, x, y, opts = {}) => {
    if (!state.effects) state.effects = [];
    if (state.effects.length > 50) state.effects.shift();
    state.effects.push({
      id: Math.random(),
      type,
      x,
      y,
      time: Date.now(),
      ...opts,
    });
  },
  explosion: (x, y, color = "red") => {
    if (!state.effects) state.effects = [];
    state.effects.push({ type: "explosion", x, y, color, time: Date.now() });
  },
  text: (text, x, y, color = "white") => {
    if (!state.effects) state.effects = [];
    state.effects.push({
      type: "floating_text",
      text,
      x,
      y,
      color,
      time: Date.now(),
    });
  },
  shake: (i = 5) => (state.cameraShake = i),
});

// ====================================================================
// --- 2. GAME CONTEXT (LA API PÚBLICA) ---
// ====================================================================

const createGameContext = (
  state,
  physics,
  mainWorld,
  signal,
  scheduler,
  userLogicRef,
  entitySys,
  renderSys,
  network
) => {
  const layers = new Map(),
    grids = new Map();

  const getEnts = (n) => {
    if (n === "*" || n === "all") {
      let a = [];
      for (const c of layers.values())
        a = a.concat(Array.isArray(c) ? c : Object.values(c));
      return a;
    }
    const c = layers.get(n);
    return c ? (Array.isArray(c) ? c : Object.values(c)) : [];
  };
  const resolveGrid = (n) =>
    typeof n === "string" && grids.has(n)
      ? grids.get(n)
      : n === "map" || n === "world"
      ? mainWorld
      : null;

  return {
    // --- CAPAS ---
    layer: (n, c, opt) => {
      layers.set(n, c);
      if (opt) grids.set(n, new UniverseCore(100));
    },

    // --- MOVIMIENTO ---
    move: (name, dt, opts = {}) => {
      const ents = getEnts(name);
      if (!ents.length) return;
      let colWorld = mainWorld;
      if (opts.obstacles) {
        if (typeof opts.obstacles === "string" && grids.has(opts.obstacles))
          colWorld = grids.get(opts.obstacles);
        else if (opts.obstacles.query) colWorld = opts.obstacles;
      }
      physics.updateGroup(
        ents,
        colWorld,
        dt,
        opts.gravity !== undefined ? opts.gravity : 300
      );
      if (grids.has(name)) {
        const g = grids.get(name);
        g.clear();
        for (const e of ents) g.add(e);
      }
    },
    collide: (lA, lB, cb) =>
      physics.collideGroups(getEnts(lA), getEnts(lB), cb),

    // --- ACTORES ---
    Actor: {
      define: (n, s) => entitySys.define(n, s),
      create: (n, x, y, p) => entitySys.create(n, x, y, p, state),
      destroy: (ent) => {
        ent._destroyed = true; /* lógica de limpieza rápida */
      },
    },

    // --- COMUNICACIÓN ---
    emit: (evt, data) => {
      signal.emit(evt, data);
      entitySys.dispatchSignal(evt, data);
    },
    on: (evt, cb) => signal.on(evt, cb),
    trigger: (id, type, params = {}) => {
      if (userLogicRef.current && userLogicRef.current.onInput)
        userLogicRef.current.onInput(
          { id, type, ...params, virtual: true },
          state
        );
    },

    // NUEVO API DE RENDERIZADO
    Render: {
      // Configurar un tipo de actor
      type: (name, config) => renderSys.setup(name, config),

      // Configurar UI Global
      ui: (key, value) => renderSys.setGlobal(key, value),

      // Configuración del sistema
      config: (opts) => {
        if (opts.precision) renderSys.rounding = opts.precision;
      },
    },

    // --- SECCIÓN ACTUALIZADA ---

    // [NUEVO] Enviar evento a UN jugador específico (ej: abrir inventario)
    sendTo: (playerId, type, data = {}) => {
      if (network && network.sendTo) {
        network.sendTo(playerId, "custom_event", { type, data });
      }
    },

    // [NUEVO] Enviar evento a TODOS (ej: mensaje de chat global)
    broadcast: (type, data = {}) => {
      if (network && network.broadcast) {
        network.broadcast("custom_event", { type, data });
      }
    },

    // --- CONSULTAS ESPACIALES ---
    getInRadius: (n, x, y, r) => {
      const g = grids.get(n);
      return g ? g.queryRadius(x, y, r) : [];
    },
    testOverlap: (ent, target, filter) => {
      const g = resolveGrid(target),
        c = g ? g.query(ent.x, ent.y, ent.w, ent.h) : getEnts(target);
      for (const o of c)
        if (o !== ent && (!filter || filter(o)) && physics.overlaps(ent, o))
          return o;
      return null;
    },
    testPoint: (x, y, target, filter) => {
      const g = resolveGrid(target),
        c = g ? g.query(x, y, 1, 1) : getEnts(target);
      for (const o of c)
        if ((!filter || filter(o)) && physics.containsPoint(o, x, y)) return o;
      return null;
    },
    testRect: (x, y, w, h, target, filter) => {
      const res = [],
        box = { x, y, w, h },
        g = resolveGrid(target),
        c = g ? g.query(x, y, w, h) : getEnts(target);
      for (const o of c)
        if ((!filter || filter(o)) && physics.overlaps(box, o)) res.push(o);
      return res;
    },
    find: (target, filter) => {
      const e = getEnts(target);
      return filter ? e.filter(filter) : e;
    },

    // --- MAPA ---
    createGrid: (s) => new UniverseCore(s),
    map: {
      add: (b) => {
        state.bloques.push(b);
        mainWorld.add(b);
      },
    },

    // --- COPIA ESTO PARA MANTENER LA COMPATIBILIDAD ---
    layer: (n, c, opt) => {
      layers.set(n, c);
      if (opt) grids.set(n, new UniverseCore(100));
    },
    move: (name, dt, opts = {}) => {
      const ents = getEnts(name);
      if (!ents.length) return;
      let colWorld = mainWorld;
      if (opts.obstacles) {
        if (typeof opts.obstacles === "string" && grids.has(opts.obstacles))
          colWorld = grids.get(opts.obstacles);
        else if (opts.obstacles.query) colWorld = opts.obstacles;
      }
      physics.updateGroup(
        ents,
        colWorld,
        dt,
        opts.gravity !== undefined ? opts.gravity : 300
      );
      if (grids.has(name)) {
        const g = grids.get(name);
        g.clear();
        for (const e of ents) g.add(e);
      }
    },
    collide: (lA, lB, cb) =>
      physics.collideGroups(getEnts(lA), getEnts(lB), cb),
    Actor: {
      define: (n, s) => entitySys.define(n, s),
      create: (n, x, y, p) => entitySys.create(n, x, y, p, state),
      destroy: (ent) => {
        ent._destroyed = true;
      },
    },
    emit: (evt, data) => {
      signal.emit(evt, data);
      entitySys.dispatchSignal(evt, data);
    },
    on: (evt, cb) => signal.on(evt, cb),
    trigger: (id, type, params = {}) => {
      if (userLogicRef.current && userLogicRef.current.onInput)
        userLogicRef.current.onInput(
          { id, type, ...params, virtual: true },
          state
        );
    },
    Render: {
      type: (name, config) => renderSys.setup(name, config),
      ui: (key, value) => renderSys.setGlobal(key, value),
      config: (opts) => {
        if (opts.precision) renderSys.rounding = opts.precision;
      },
    },
    getInRadius: (n, x, y, r) => {
      const g = grids.get(n);
      return g ? g.queryRadius(x, y, r) : [];
    },
    testOverlap: (ent, target, filter) => {
      const g = resolveGrid(target),
        c = g ? g.query(ent.x, ent.y, ent.w, ent.h) : getEnts(target);
      for (const o of c)
        if (o !== ent && (!filter || filter(o)) && physics.overlaps(ent, o))
          return o;
      return null;
    },
    testPoint: (x, y, target, filter) => {
      const g = resolveGrid(target),
        c = g ? g.query(x, y, 1, 1) : getEnts(target);
      for (const o of c)
        if ((!filter || filter(o)) && physics.containsPoint(o, x, y)) return o;
      return null;
    },
    testRect: (x, y, w, h, target, filter) => {
      const res = [],
        box = { x, y, w, h },
        g = resolveGrid(target),
        c = g ? g.query(x, y, w, h) : getEnts(target);
      for (const o of c)
        if ((!filter || filter(o)) && physics.overlaps(box, o)) res.push(o);
      return res;
    },
    find: (target, filter) => {
      const e = getEnts(target);
      return filter ? e.filter(filter) : e;
    },
    createGrid: (s) => new UniverseCore(s),
    map: {
      add: (b) => {
        state.bloques.push(b);
        mainWorld.add(b);
      },
    },
  };
};

// ====================================================================
// --- 3. COMPILADOR (VINCULA TODO) ---
// ====================================================================

// AHORA ACEPTA 'io' (opcional)
function compileLogic(serverLogic, initialState, roomId, ioInstance) {
  if (!initialState._sys)
    Object.defineProperty(initialState, "_sys", {
      value: { spawnQueue: [], killQueue: [] },
      writable: true,
      enumerable: false,
    });

  // 1. Instancias de Sala
  const roomWorld = new UniverseCore(100);
  if (initialState.bloques)
    initialState.bloques.forEach((b) => roomWorld.add(b));

  const roomScheduler = new SchedulerCore();
  const roomSignal = new SignalCore();
  const roomEntities = new EntityCore(roomSignal);
  const userLogicRef = { current: null };
  const roomRender = new RenderCore();

  // [NUEVO] CREAR PUENTE DE RED
  const networkBridge = {
    sendTo: (socketId, event, payload) => {
      if (ioInstance) ioInstance.to(socketId).emit(event, payload);
    },
    broadcast: (event, payload) => {
      if (ioInstance) ioInstance.to(roomId).emit(event, payload);
    },
  };

  // 2. Crear API (Pasamos networkBridge al final)
  const gameAPI = createGameContext(
    initialState,
    PhysicsCore,
    roomWorld,
    roomSignal,
    roomScheduler,
    userLogicRef,
    roomEntities,
    roomRender,
    networkBridge
  );
  const fxAPI = createFXContext(initialState);

  // 3. Crear Sandbox
  const sandbox = {
    state: initialState,
    console: console,
    API_BASE_URL: API_BASE_URL,
    fetch: nodeFetch,

    Render: gameAPI.Render, // Acceso directo

    // --- API EXPUESTA ---
    Game: gameAPI,
    Actor: gameAPI.Actor, // Atajo
    FX: fxAPI,
    Timer: {
      wait: (s, cb) => roomScheduler.wait(s, cb),
      every: (s, cb) => roomScheduler.every(s, cb),
    },
    MathUtils: {
      dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
      angle: (a, b) => Math.atan2(b.y - a.y, b.x - a.x),
      lerp: (a, b, t) => a + (b - a) * t,
      randomRange: (min, max) => Math.random() * (max - min) + min,
      dirTo: (from, to) => ({
        x: Math.cos(Math.atan2(to.y - from.y, to.x - from.x)),
        y: Math.sin(Math.atan2(to.y - from.y, to.x - from.x)),
      }),
    },
    // IA y BOT (Legacy support)
    AI: async function (prompt, model = "gemini-2.5-flash") {
      const url = `${API_BASE_URL}/api/ai/generate`;
      try {
        const response = await this.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, model }),
        });
        const data = await response.json();
        return data.response || data.error || "Error desconocido";
      } catch (e) {
        return "Error de red: " + e.message;
      }
    },
    Bot: {
      create: (c) => {
        const id = "b_" + Math.random().toString(36).substr(2, 5);
        initialState._sys.spawnQueue.push({ id, config: c });
        return id;
      },
      destroy: (id) => initialState._sys.killQueue.push(id),
    },
  };

  // 4. Inyección y Wrapper de Sistemas
  sandbox.__sys_update = (dt) => {
    roomScheduler.update(dt); // Avanzar Timer
    roomEntities.processLogic(dt, gameAPI); // Avanzar Actores (onUpdate)
  };
  // IMPORTANTE: Nueva función del sistema para extraer el Snapshot
  // Esta función la llamará tu servidor en el setInterval de Socket.io
  sandbox.__sys_get_snapshot = () => {
    return roomRender.processSnapshot(
      roomEntities.activeEntities,
      initialState.effects || []
    );
  };
  sandbox.__sys_input = (id, input) => {
    roomEntities.dispatchInput(id, input); // Inputs a Actores
  };

  const scriptCode = `
        AI.generate = AI.bind(this);
        ${serverLogic}
        const _uUpdate = (typeof onUpdate!=='undefined'?onUpdate:null);
        const _uInput = (typeof onInput!=='undefined'?onInput:null);
        
        ;({
            onUpdate: (state, dt) => {
                if(typeof __sys_update === 'function') __sys_update(dt); 
                if(_uUpdate) _uUpdate(state, dt);
            },
            onInput: (payload, state) => {
                if(typeof __sys_input === 'function') __sys_input(payload.id, payload);
                if(_uInput) _uInput(payload, state);
            },
            onBot: (typeof onBot!=='undefined'?onBot:null)
        })
    `;

  try {
    const userLogic = new vm.Script(scriptCode).runInNewContext(sandbox);
    userLogicRef.current = userLogic; // Referencia para Game.trigger
    return {
      userLogic,
      state: sandbox.state,
      // Exponemos la función de renderizado segura para el servidor
      renderFn: () =>
        roomRender.processSnapshot(
          roomEntities.activeEntities,
          sandbox.state.effects || []
        ),
    };
  } catch (e) {
    console.error("Compile Error:", e.message);
    throw new Error("Compilation failed: " + e.message);
  }
}
// ... (El resto del código de API sigue igual)

// ... (La función stopRoom sigue igual)
function stopRoom(roomId) {
  const r = rooms[roomId];
  if (r) {
    clearInterval(r.interval);
    delete rooms[roomId];
    console.log(`[-] Sala ${roomId} liberada de memoria.`);
  }
}

// ==============================================================
// ENDPOINT DE API HTTP PARA LA GENERACIÓN DE IA (GEMINI)
// ==============================================================

/**
 * POST /api/ai/generate
 * Envía un prompt a Gemini 2.5 Flash y devuelve la respuesta.
 */
app.post("/api/ai/generate", async (req, res) => {
  // Parámetros opcionales del cuerpo: prompt, model
  const { prompt, model = "gemini-2.5-flash" } = req.body;

  if (!prompt) {
    return res.status(400).send({ error: "Missing prompt." });
  }

  try {
    // CORRECCIÓN: La forma correcta de llamar al modelo
    const aiModel = genAI.getGenerativeModel({ model: model });

    const result = await aiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log(`[AI SUCCESS] Respuesta generada.`);
    res.send({ success: true, response: text });
  } catch (e) {
    console.error("❌ Error en la API de Gemini:", e.message);
    res.status(500).send({ success: false, error: e.message });
  }
});

// ==============================================================
// ENDPOINTS DE API HTTP PARA PERSISTENCIA DE ESTADO (GAME STATE)
// ==============================================================

/**
 * POST /api/game-state/save
 * Guarda el estado del juego (gameStateData) para un roomId específico.
 * Utilizado por la lógica del servidor cuando se requiere guardar el progreso.
 */
app.post("/api/game-state/save", async (req, res) => {
  const { roomId, gameStateData } = req.body;

  if (!roomId || !gameStateData) {
    return res.status(400).send({ error: "Missing roomId or gameStateData." });
  }

  try {
    // Asegúrate de que gameStateData es una cadena (string) para el JSONB/Text de Supabase
    const stateString =
      typeof gameStateData === "object"
        ? JSON.stringify(gameStateData)
        : gameStateData;

    const { error: dbError } = await supabase
      .from("game_rooms")
      .update({
        game_state_data: stateString,
      })
      .eq("name", roomId);

    if (dbError) {
      console.error(
        `[SAVE ERROR ${roomId}] Error al guardar estado en Supabase:`,
        dbError
      );
      return res
        .status(500)
        .send({ error: "Database save failed: " + dbError.message });
    }

    console.log(`[STATE SAVE ${roomId}] Estado guardado correctamente.`);
    res.send({ success: true, message: "Game state saved successfully." });
  } catch (e) {
    console.error(`[STATE SAVE ERROR ${roomId}]`, e.message);
    res
      .status(500)
      .send({ error: "Server error during state save: " + e.message });
  }
});

/**
 * GET /api/game-state/load/{roomId}
 * Obtiene el estado del juego (gameStateData) para un roomId específico.
 * Utilizado por la lógica del servidor para cargar datos en tiempo real (si es necesario) o por la API de Spring Boot.
 */
app.get("/api/game-state/load/:roomId", async (req, res) => {
  const roomId = req.params.roomId;

  try {
    const { data: roomData, error: dbError } = await supabase
      .from("game_rooms")
      .select("game_state_data")
      .eq("name", roomId)
      .single();

    if (dbError || !roomData) {
      console.error(
        `[LOAD ERROR ${roomId}] Error al cargar estado:`,
        dbError ? dbError.message : "Room not found."
      );
      return res
        .status(404)
        .send({ error: "Game state not found or database error." });
    }

    // Devolver el dato tal cual se almacena (string JSON o null)
    const gameStateData = roomData.game_state_data;

    console.log(`[STATE LOAD ${roomId}] Estado cargado.`);
    res.send({
      success: true,
      gameStateData: gameStateData ? JSON.parse(gameStateData) : null,
    });
  } catch (e) {
    console.error(`[STATE LOAD ERROR ${roomId}]`, e.message);
    res
      .status(500)
      .send({ error: "Server error during state load: " + e.message });
  }
});

// ==============================================================
// ENDPOINT API HTTP PARA RECIBIR PUBLICACIÓN DEL EDITOR (SPRING BOOT)
// ==============================================================

app.post("/api/publish-room", async (req, res) => {
  // ... (El código de publish-room, SOCKET.IO LOGIC, y todo lo demás permanece sin cambios)
  // ... (Tu lógica de publish-room)
  const {
    roomId,
    serverLogic,
    clientStructureHtml,
    clientRenderScript,
    clientInputScript,
  } = req.body;

  if (!roomId) {
    return res.status(400).send({ error: "Missing roomId." });
  }

  try {
    // 2. GUARDAR DATOS EN SUPABASE (Node.js hace el POST)
    // ... (Tu lógica de guardado en Supabase permanece igual)
    const { error: dbError } = await supabase
      .from("game_rooms")
      .update({
        server_logic: serverLogic,
        client_structure_html: clientStructureHtml,
        client_render_script: clientRenderScript,
        client_input_script: clientInputScript,
      })
      .eq("name", roomId);

    if (dbError) {
      console.error("Error al guardar en Supabase (Node):", dbError);
      return res.status(500).send({ error: "Database save failed." });
    }

    // 3. ACTUALIZACIÓN EN VIVO (Si la sala está activa en memoria)
    if (rooms[roomId]) {
      const room = rooms[roomId];

      // A. Recompilar la lógica del SERVIDOR
      const { userLogic } = compileLogic(serverLogic, room.state);
      room.logic = userLogic;

      // B. Notificar a los clientes por Socket.io para recargar/actualizar
      // *** CAMBIO CLAVE AQUÍ: Emitir los datos del cliente ***
      io.to(roomId).emit("design_update", {
        // Renombramos el evento si usaste 'system_update' antes
        structure: clientStructureHtml,
        renderScript: clientRenderScript,
        // Nota: Los scripts se envían sin las etiquetas <script> para facilitar la inyección
        inputScript: clientInputScript,
      });
    }

    console.log(
      `[LIVE UPDATE ${roomId}] Lógica Server recompilada y DB actualizada.`
    );
    res.send({
      success: true,
      message: "Published and live update initiated.",
    });
  } catch (e) {
    console.error(`[PUBLISH ERROR ${roomId}]`, e.message);
    res
      .status(500)
      .send({ error: "Server error during live update: " + e.message });
  }
});
// ==============================================================
// SOCKET.IO LOGIC
// ==============================================================

io.on("connection", async (socket) => {
  // ... (Tu lógica de Socket.io permanece sin cambios)

  socket.on("join_room", async (roomId, userId) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;

    // 1. INICIALIZAR SALA SI NO EXISTE EN MEMORIA
    if (!rooms[roomId]) {
      console.log(`[*] Buscando sala por NOMBRE: "${roomId}"...`);

      const { data: roomData, error: roomError } = await supabase
        .from("game_rooms")
        .select("server_logic, owner_id, game_state_data")
        .eq("name", roomId) // <--- CAMBIO CLAVE: 'id' a 'name'
        .single();

      if (roomError || !roomData) {
        console.error("❌ Error al despertar sala:", roomError?.message);
        return socket.emit("system_error", "No se pudo cargar la sala.");
      }

      console.log(`✅ Sala "${roomId}" encontrada. Iniciando motor...`);

      /// --- LÓGICA DE CARGA DINÁMICA ---
      let initialState;
      try {
        // Si está vacío o es null, inicializamos un JSON base por defecto
        initialState = roomData.game_state_data
          ? JSON.parse(roomData.game_state_data)
          : { jugadores_data: {}, score: 0, initialized: false, jugadores: [] };
      } catch (e) {
        initialState = {
          jugadores_data: {},
          score: 0,
          initialized: false,
          jugadores: [],
        };
      }

      // *** CORRECCIÓN CRÍTICA AQUÍ ***
      // *** CAMBIO 1: Pasar 'io' como 4to argumento ***
      const compiled = compileLogic(
        roomData.server_logic,
        initialState,
        roomId,
        io // <--- PASAR LA INSTANCIA GLOBAL DE SOCKET.IO
      );

      rooms[roomId] = {
        inputQueue: [], // <--- NUEVA COLA DE SECUENCIAS
        state: compiled.state,
        logic: compiled.userLogic,
        renderFn: compiled.renderFn, // <--- ¡ESTO ES CRUCIAL!
        ownerId: roomData.owner_id,
        players: new Set(),
        bots: new Map(), // CAMBIO: Usamos un Map para acceso rápido por ID
        interval: null,
      };

      // GAME LOOP PROFESIONAL
      rooms[roomId].interval = setInterval(() => {
        const r = rooms[roomId];

        try {
          // ==================================================
          // 1. PROCESAR SECUENCIA DE INPUTS
          // ==================================================
          while (r.inputQueue.length > 0) {
            const input = r.inputQueue.shift(); // FIFO
            if (r.logic.onInput) {
              r.logic.onInput(input, r.state);
            }
          }

          // ==================================================
          // 2. UPDATE DE FÍSICA Y LÓGICA (SERVER)
          // ==================================================
          if (r.logic.onUpdate) r.logic.onUpdate(r.state, 0.016);

          // ==================================================
          // 3. GESTIÓN DE BOTS (IA)
          // ==================================================

          // A. Spawn de Bots
          if (r.state._sys && r.state._sys.spawnQueue.length > 0) {
            const queue = r.state._sys.spawnQueue;
            while (queue.length > 0) {
              const req = queue.shift();
              // Crear memoria del bot
              r.bots.set(req.id, {
                myId: req.id,
                config: req.config || {},
                memory: {},
              });
              // Crear cuerpo en el state
              if (!r.state.jugadores_data) r.state.jugadores_data = {}; // Fallback si no usas EntitySystem

              // NOTA: Si usas el nuevo sistema Actor, esto se maneja en EntityCore,
              // pero lo dejamos por compatibilidad con bots legacy.
              r.state.jugadores_data[req.id] = {
                id: req.id,
                x: req.config.x || 0,
                y: req.config.y || 0,
                ...req.config,
              };
            }
          }

          // B. Muerte de Bots
          if (r.state._sys && r.state._sys.killQueue.length > 0) {
            const queue = r.state._sys.killQueue;
            while (queue.length > 0) {
              const botId = queue.shift();
              r.bots.delete(botId);
              if (r.state.jugadores_data) delete r.state.jugadores_data[botId];
            }
          }

          // C. Update de IA de Bots
          if (r.logic.onBot && r.logic.onInput) {
            for (const [botId, botData] of r.bots) {
              const action = r.logic.onBot(
                r.state,
                botData.memory,
                botData.config
              );
              if (action) {
                action.id = botId;
                r.logic.onInput(action, r.state);
              }
            }
          }

          // ==================================================
          // 4. RENDERIZADO OPTIMIZADO (SNAPSHOT)
          // ==================================================

          let packet = null;

          // Usamos la función renderFn que nos devolvió compileLogic
          // Esta función ejecuta roomRender.processSnapshot() internamente
          if (r.renderFn) {
            packet = r.renderFn();
          }
          // Fallback: Si no hay sistema de render, enviar state crudo (legacy)
          else {
            packet = r.state;
          }

          if (packet) {
            // Emitimos el paquete optimizado { g, e, fx }
            io.to(roomId).emit("render_update", packet);

            // Limpiamos los efectos ya enviados para no duplicarlos
            if (r.state.effects) r.state.effects = [];
          }
        } catch (e) {
          console.error(`[CRASH ROOM ${roomId}]`, e);
          stopRoom(roomId);
        }
      }, 1000 / 60); // 60 FPS
    }

    // 2. AÑADIR JUGADOR REAL (Solo después de asegurar que la sala existe)
    const room = rooms[roomId];
    if (room) {
      room.players.add(socket.id);

      // *** CAMBIO 2: ENVIAR EL MAPA AL CLIENTE AL CONECTAR ***
      // Enviamos la lista de bloques estáticos para que el cliente la guarde en caché
      socket.emit("map_data", room.state.bloques || []);

      // Registrar en el array de jugadores para el renderizado si no existe
      const playerId = socket.userId || socket.id;
      if (!room.state.jugadores.find((p) => p.id === playerId)) {
        room.state.jugadores.push({
          id: playerId,
          nombre: socket.userId
            ? "Player_" + socket.userId.substr(0, 4)
            : "Anon_" + socket.id.substr(0, 4),
          pos: { x: 50, z: 50 },
        });
      }

      console.log(`[+] Clientes en "${roomId}": ${room.players.size}`);
    }
  });

  // ==========================================
  // SISTEMA DE SEÑALIZACIÓN WebRTC (Voz)
  // ESTO DEBE ESTAR DENTRO DE io.on('connection') PERO FUERA DE join_room
  // Y DEBE USAR socket.roomId QUE YA FUE SETEADO
  // ==========================================

  socket.on("voice_join", () => {
    // Usamos socket.roomId porque 'roomId' no existe en este scope
    const room = socket.roomId;
    if (room) {
      socket.to(room).emit("voice_user_joined", socket.id);
    }
  });

  socket.on("voice_signal", (payload) => {
    io.to(payload.targetId).emit("voice_signal", {
      senderId: socket.id,
      signal: payload.signal,
    });
  });

  socket.on("sim_input", (payload) => {
    const r = rooms[socket.roomId];
    if (r) {
      payload.id = socket.userId || socket.id;
      payload.ts = Date.now(); // Marca de tiempo
      r.inputQueue.push(payload); // Agregamos a la secuencia
    }
  });

  socket.on("disconnect", async () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.players.delete(socket.id);

      console.log(
        `[-] Cliente salió de "${roomId}". Restantes: ${room.players.size}`
      );

      // Limpiar al jugador del estado visual (opcional, según tu mod)
      if (room.state.jugadores) {
        room.state.jugadores = room.state.jugadores.filter(
          (p) => p.id !== (socket.userId || socket.id)
        );
      }

      // --- PERSISTENCIA AUTOMÁTICA AL QUEDAR EN 0 ---
      if (room.players.size === 0) {
        console.log(
          `[!] Sala "${roomId}" sin humanos. Guardando y liberando RAM...`
        );

        try {
          // Convertimos el estado actual a String
          const stateToSave = JSON.stringify(room.state);

          const { error: saveError } = await supabase
            .from("game_rooms")
            .update({ game_state_data: stateToSave })
            .eq("name", roomId);

          if (saveError) throw saveError;
          console.log(`✅ Persistencia exitosa para "${roomId}".`);
        } catch (err) {
          console.error(
            `❌ Error crítico al guardar "${roomId}":`,
            err.message
          );
        } finally {
          // Detener motor y borrar de memoria
          stopRoom(roomId);
        }
      }
    }
  });
});
