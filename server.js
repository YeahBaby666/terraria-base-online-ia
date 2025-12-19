const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const vm = require("vm");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const nodeFetch = require("node-fetch");

// ====================================================================
// --- CONFIGURACIÓN ---
// ====================================================================
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
const SUPABASE_URL = process.env.SUPABASE_URL || "TU_SUPABASE_URL";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "TU_SUPABASE_KEY";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TU_GEMINI_KEY";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
  console.log(`🚀 Servidor Engine IO (Full Stack) en puerto ${PORT}`);
});

const io = new Server(httpServer, { cors: { origin: "*" } });
const rooms = {};

// ====================================================================
// --- 1. MOTORES DEL NÚCLEO (ARQUITECTURA DE CAPAS) ---
// ====================================================================

/** RENDER CORE: Gestor de Vista (Versión Estable) */
class RenderCore {
  constructor() {
    this.configs = new Map();
    this.globals = {};
    this.rounding = 1;
    this.debugMode = false; // Por defecto optimizado

    // Diccionarios de traducción (DEFINIDOS EN EL CONSTRUCTOR)
    this.KEYS = {
      PROD: { pack: "e", global: "g", effect: "fx", type: "t" },
      DEV: {
        pack: "entities",
        global: "globals",
        effect: "effects",
        type: "sprite",
      },
    };
  }

  setup(typeName, config) {
    this.configs.set(typeName, {
      sprite: "default",
      props: ["x", "y"],
      map: null,
      group: typeName.toLowerCase() + "s",
      ...config,
    });
  }

  setGlobal(key, value) {
    this.globals[key] = value;
  }

  setDebug(isEnabled) {
    this.debugMode = !!isEnabled; // Forzar booleano
  }

  processSnapshot(state, effects) {
    try {
      // 1. Seleccionar claves según modo
      const K = this.debugMode ? this.KEYS.DEV : this.KEYS.PROD;
      const entitiesPacket = [];

      this.configs.forEach((config, typeName) => {
        const groupName = config.group;

        if (state[groupName]) {
          const collection = Array.isArray(state[groupName])
            ? state[groupName]
            : Object.values(state[groupName]);

          for (const ent of collection) {
            if (ent._dead) continue;

            // Objeto visual básico
            const visual = { id: ent.id };

            // Asignar tipo visual (t o sprite)
            visual[K.type] = config.sprite;

            // Copiar propiedades numéricas con redondeo
            for (const prop of config.props) {
              const val = ent[prop];
              if (typeof val === "number") {
                visual[prop] = Number(val.toFixed(this.rounding));
              } else {
                visual[prop] = val;
              }
            }

            // Mapas personalizados (si existen)
            if (config.map) {
              try {
                Object.assign(visual, config.map(ent));
              } catch (e) {}
            }
            entitiesPacket.push(visual);
          }
        }
      });

      // 2. Construir Paquete
      const packet = {};
      packet[K.global] = this.globals;
      packet[K.pack] = entitiesPacket;
      packet[K.effect] = effects || [];

      return packet;
    } catch (error) {
      console.error("CRITICAL RENDER ERROR:", error);
      // En caso de emergencia, devolver paquete vacío para no colgar al cliente
      return { error: "Render failed", g: {}, e: [], fx: [] };
    }
  }
}

/** PHYSICS CORE: Lógica de movimiento y colisión */
const PhysicsCore = {
  overlaps: (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,

  updateLayer: function (entities, layerGrid, dt) {
    if (!entities) return;
    if (layerGrid) layerGrid.clear();
    for (const ent of entities) {
      if (ent._dead) continue;
      ent.x += (ent.vx || 0) * dt;
      ent.y += (ent.vy || 0) * dt;
      if (layerGrid) layerGrid.add(ent);
    }
  },

  collideLayers: function (entitiesA, layerGridB, cb) {
    if (!entitiesA || !layerGridB) return;
    for (const a of entitiesA) {
      if (a._dead) continue;
      const nearby = layerGridB.query(a.x, a.y, a.w || 32, a.h || 32);
      for (const b of nearby) {
        if (b === a || b._dead) continue;
        if (this.overlaps(a, b)) cb(a, b);
      }
    }
  },
};

/** UNIVERSE CORE: Sistema de Rejilla */
class UniverseCore {
  constructor(cellSize) {
    this.cellSize = cellSize || 100;
    this.grid = new Map();
  }
  clear() {
    this.grid.clear();
  }
  add(obj) {
    const w = obj.w || 32;
    const h = obj.h || 32;
    const sx = Math.floor(obj.x / this.cellSize);
    const ex = Math.floor((obj.x + w) / this.cellSize);
    const sy = Math.floor(obj.y / this.cellSize);
    const ey = Math.floor((obj.y + h) / this.cellSize);
    for (let x = sx; x <= ex; x++) {
      for (let y = sy; y <= ey; y++) {
        const k = `${x},${y}`;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(obj);
      }
    }
  }
  query(x, y, w, h) {
    const res = new Set();
    const sx = Math.floor(x / this.cellSize);
    const ex = Math.floor((x + w) / this.cellSize);
    const sy = Math.floor(y / this.cellSize);
    const ey = Math.floor((y + h) / this.cellSize);
    for (let x = sx; x <= ex; x++) {
      for (let y = sy; y <= ey; y++) {
        const cell = this.grid.get(`${x},${y}`);
        if (cell) for (const obj of cell) res.add(obj);
      }
    }
    return res;
  }
}

/** HELPER: Actor Factory */
const ActorFactory = {
  definitions: new Map(),
  define: (name, schema) => ActorFactory.definitions.set(name, schema),
  create: (name, x, y, extra = {}, state) => {
    const def = ActorFactory.definitions.get(name);
    if (!def) return null;
    const ent = {
      id: name + "_" + Math.random().toString(36).substr(2, 5),
      x,
      y,
      vx: 0,
      vy: 0,
      w: 32,
      h: 32,
      _type: name,
      ...JSON.parse(JSON.stringify(def.vars || {})),
      ...extra,
    };
    if (def.onCreate) def.onCreate(ent);

    const group = def.group || "default";
    if (!state[group]) state[group] = [];
    if (Array.isArray(state[group])) state[group].push(ent);
    return ent;
  },
  destroy: (ent) => {
    ent._dead = true;
  },
};

// ====================================================================
// --- 2. GAME CONTEXT & SANDBOX ---
// ====================================================================

const createGameContext = (state, renderSys, network) => {
  const layers = new Map();
  return {
    layer: (g, s) => layers.set(g, new UniverseCore(s)),
    move: (g, dt) => {
      const entities = state[g];
      if (Array.isArray(entities)) {
        for (let i = entities.length - 1; i >= 0; i--)
          if (entities[i]._dead) entities.splice(i, 1);
      }
      PhysicsCore.updateLayer(entities, layers.get(g), dt);
    },
    collide: (gA, gB, cb) => {
      if (state[gA] && layers.get(gB))
        PhysicsCore.collideLayers(state[gA], layers.get(gB), cb);
    },
    find: (g) => state[g] || [],
    Actor: {
      define: ActorFactory.define,
      create: (n, x, y, e) => ActorFactory.create(n, x, y, e, state),
      destroy: ActorFactory.destroy,
    },
    Render: {
      type: (n, c) => renderSys.setup(n, c),
      config: (c) => {
        if (c.precision) renderSys.rounding = c.precision;
        // --- NUEVO: Activar traductor ---
        if (typeof c.debug !== "undefined") renderSys.setDebug(c.debug);
      },
      setGlobal: (k, v) => renderSys.setGlobal(k, v), // Asegúrate de tener esto expuesto
    },
    FX: {
      spawn: (t, x, y) => {
        if (!state.effects) state.effects = [];
        state.effects.push({ type: t, x, y, id: Math.random() });
      },
    },
    sendTo: network.sendTo,
    broadcast: network.broadcast,
  };
};

function compileLogic(serverLogic, initialState, roomId, ioInstance) {
  // 1. Inicializar Sistema de Control (_sys) para Bots
  if (!initialState.effects) initialState.effects = [];
  if (!initialState._sys)
    Object.defineProperty(initialState, "_sys", {
      value: { spawnQueue: [], killQueue: [] },
      writable: true,
      enumerable: false,
    });

  const roomRender = new RenderCore();

  const networkBridge = {
    sendTo: (sid, type, data) =>
      ioInstance.to(sid).emit("custom_event", { type, data }),
    broadcast: (type, data) =>
      ioInstance.to(roomId).emit("custom_event", { type, data }),
  };

  const GameAPI = createGameContext(initialState, roomRender, networkBridge);

  const sandbox = {
    state: initialState,
    console: console,
    fetch: nodeFetch, // Necesario para IA
    Game: GameAPI,
    Actor: GameAPI.Actor,
    Render: GameAPI.Render,
    FX: GameAPI.FX,
    MathUtils: {
      angle: (a, b) => Math.atan2(b.y - a.y, b.x - a.x),
      dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
      randomRange: (min, max) => Math.random() * (max - min) + min,
    },
    // --- RESTAURADO: IA ---
    AI: async function (prompt, model = "gemini-2.5-flash") {
      const url = `${API_BASE_URL}/api/ai/generate`;
      try {
        const response = await nodeFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, model }),
        });
        const data = await response.json();
        return data.response || data.error;
      } catch (e) {
        return "Error IA: " + e.message;
      }
    },
    // --- RESTAURADO: BOT HELPERS ---
    Bot: {
      create: (config) => {
        const id = "bot_" + Math.random().toString(36).substr(2, 5);
        initialState._sys.spawnQueue.push({ id, config });
        return id;
      },
      destroy: (id) => initialState._sys.killQueue.push(id),
    },
  };

  const code = `
        ${serverLogic}
        ;({
            onUpdate: (typeof onUpdate !== 'undefined' ? onUpdate : null),
            onInput: (typeof onInput !== 'undefined' ? onInput : null),
            onBot: (typeof onBot !== 'undefined' ? onBot : null)
        })
    `;

  try {
    const userLogic = new vm.Script(code).runInNewContext(sandbox);
    return {
      userLogic,
      state: initialState,
      renderFn: () =>
        roomRender.processSnapshot(initialState, initialState.effects),
    };
  } catch (e) {
    console.error("Error compilando lógica:", e);
    return { state: initialState, userLogic: {} };
  }
}

// ====================================================================
// --- 4. GESTIÓN DE SALAS Y SOCKETS ---
// ====================================================================

io.on("connection", async (socket) => {
  socket.on("join_room", async (roomId, userId) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;

    if (!rooms[roomId]) {
      console.log(`[*] Iniciando sala: ${roomId}`);
      const { data } = await supabase
        .from("game_rooms")
        .select("*")
        .eq("name", roomId)
        .single();
      if (!data) return socket.emit("system_error", "Sala no encontrada");

      let state = data.game_state_data ? JSON.parse(data.game_state_data) : {};
      const compiled = compileLogic(data.server_logic, state, roomId, io);

      rooms[roomId] = {
        state: compiled.state,
        logic: compiled.userLogic,
        renderFn: compiled.renderFn,
        inputQueue: [],
        players: new Set(),
        bots: new Map(), // Memoria para bots
      };

      // GAME LOOP
      rooms[roomId].interval = setInterval(() => {
        const r = rooms[roomId];
        try {
          // 1. INPUTS
          while (r.inputQueue.length > 0) {
            const input = r.inputQueue.shift();
            if (r.logic.onInput) r.logic.onInput(input, r.state);
          }

          // 2. GESTIÓN DE BOTS (Restaurado)
          // A. Spawn
          if (r.state._sys && r.state._sys.spawnQueue.length > 0) {
            const q = r.state._sys.spawnQueue;
            while (q.length > 0) {
              const req = q.shift();
              // Usamos ActorFactory para crear el cuerpo físico del Bot
              // Asumimos que config tiene { type: 'Zombie', x: 0, y: 0 }
              const type = req.config.type || "Zombie"; // Default fallback
              const ent = ActorFactory.create(
                type,
                req.config.x || 0,
                req.config.y || 0,
                { isBot: true, ...req.config },
                r.state
              );

              // Registrar en memoria de control
              r.bots.set(ent.id, { id: ent.id, memory: {} });
            }
          }
          // B. Kill
          if (r.state._sys && r.state._sys.killQueue.length > 0) {
            const q = r.state._sys.killQueue;
            while (q.length > 0) {
              const id = q.shift();
              r.bots.delete(id);
              // Buscar y matar entidad en todos los grupos (ineficiente pero seguro)
              for (const k in r.state) {
                if (Array.isArray(r.state[k])) {
                  const e = r.state[k].find((x) => x.id === id);
                  if (e) e._dead = true;
                }
              }
            }
          }
          // C. Update IA
          if (r.logic.onBot) {
            for (const [botId, botCtrl] of r.bots) {
              // Buscar entidad física
              let ent = null;
              // Buscamos en los grupos comunes (optimizable si sabemos el grupo)
              if (r.state.enemies)
                ent = r.state.enemies.find((e) => e.id === botId);
              if (!ent && r.state.players)
                ent = r.state.players.find((e) => e.id === botId);

              if (ent && !ent._dead) {
                const action = r.logic.onBot(ent, botCtrl.memory, r.state);
                if (action && r.logic.onInput) {
                  action.id = botId; // Auto-firmar input
                  r.logic.onInput(action, r.state);
                }
              }
            }
          }

          // 3. UPDATE GENERAL
          if (r.logic.onUpdate) r.logic.onUpdate(r.state, 0.016);

          // 4. RENDER
          if (r.renderFn) {
            const packet = r.renderFn();
            io.to(roomId).emit("render_update", packet);
            r.state.effects = [];
          }
        } catch (e) {
          console.error(`Crash en sala ${roomId}:`, e.message);
        }
      }, 16);
    }

    const r = rooms[roomId];
    r.players.add(socket.id);
    socket.emit("map_data", r.state.bloques || []);
    console.log(`[+] Jugador en ${roomId}`);
  });

  // --- NUEVO: Protocolo Optimizado (Tick Rate) ---
  socket.on("client_tick", (packet) => {
    if (!socket.roomId || !rooms[socket.roomId]) return;

    const r = rooms[socket.roomId];
    const playerId = socket.userId || socket.id;

    // 1. Desempaquetar Movimiento (Solo el último importa)
    if (packet.move) {
      // Reconstruimos el evento para que la lógica (VM) lo entienda igual que antes
      r.inputQueue.push({
        type: "player_move", // El tipo estándar para movimiento
        ...packet.move, // x, y, rot, etc.
        id: playerId,
      });
    }

    // 2. Desempaquetar Acciones (Disparos, skills, etc.)
    if (packet.actions && Array.isArray(packet.actions)) {
      for (const action of packet.actions) {
        // action viene como: { type: 'shoot', payload: { ... } }
        // Lo aplanamos para el VM: { type: 'shoot', id: '...', ...payload }
        r.inputQueue.push({
          type: action.type,
          ...action.payload,
          id: playerId,
        });
      }
    }
  });

  // --- RESTAURADO: PERSISTENCIA AL SALIR ---
  socket.on("disconnect", async () => {
    if (!socket.roomId || !rooms[socket.roomId]) return;
    const r = rooms[socket.roomId];
    r.players.delete(socket.id);

    if (r.players.size === 0) {
      console.log(`[!] Sala ${socket.roomId} vacía. Guardando estado...`);
      clearInterval(r.interval);

      // 1. Guardar en Supabase
      try {
        const jsonState = JSON.stringify(r.state);
        await supabase
          .from("game_rooms")
          .update({ game_state_data: jsonState })
          .eq("name", socket.roomId);
        console.log("✅ Estado guardado.");
      } catch (e) {
        console.error("❌ Error guardando:", e.message);
      }

      // 2. Liberar memoria
      delete rooms[socket.roomId];
    }
  });

  // WebRTC
  socket.on("voice_join", () => {
    if (socket.roomId)
      socket.to(socket.roomId).emit("voice_user_joined", socket.id);
  });
  socket.on("voice_signal", (p) =>
    io
      .to(p.targetId)
      .emit("voice_signal", { senderId: socket.id, signal: p.signal })
  );
});

// Endpoints API
app.post("/api/publish-room", async (req, res) => {
  const {
    roomId,
    serverLogic,
    clientStructureHtml,
    clientRenderScript,
    clientInputScript,
  } = req.body;
  await supabase
    .from("game_rooms")
    .update({
      server_logic: serverLogic,
      client_structure_html: clientStructureHtml,
      client_render_script: clientRenderScript,
      client_input_script: clientInputScript,
    })
    .eq("name", roomId);

  if (rooms[roomId]) {
    const r = rooms[roomId];
    const c = compileLogic(serverLogic, r.state, roomId, io);
    r.logic = c.userLogic;
    r.renderFn = c.renderFn;
    io.to(roomId).emit("design_update", {
      structure: clientStructureHtml,
      renderScript: clientRenderScript,
      inputScript: clientInputScript,
    });
  }
  res.json({ ok: true });
});

// Endpoint IA
app.post("/api/ai/generate", async (req, res) => {
  const { prompt, model = "gemini-2.5-flash" } = req.body;
  try {
    const aiModel = genAI.getGenerativeModel({ model });
    const result = await aiModel.generateContent(prompt);
    res.send({ success: true, response: result.response.text() });
  } catch (e) {
    res.status(500).send({ success: false, error: e.message });
  }
});
