const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const vm = require("vm");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ====================================================================
// --- CONFIGURACIÓN ---
// ====================================================================
const PORT = process.env.PORT || 3000;
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://uucetvaiesfwuxmwukvg.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1Y2V0dmFpZXNmd3V4bXd1a3ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU3MzEzMjUsImV4cCI6MjA4MTMwNzMyNX0.B6abitvRPUeZPPFUiqYhXf0MsBx2bRpJMz3wPgyKfbE";
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "AIzaSyBFPuZlt6z1cM55IYVEahV6uLLkuqhBFYE";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(bodyParser.json());

const httpServer = app.listen(PORT, () =>
  console.log(`🚀 Motor (Hot Reload Ready) en puerto ${PORT}`)
);
const io = new Server(httpServer, { cors: { origin: "*" } });

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const rooms = {};

// ====================================================================
// --- 1. GAME CONTEXT ---
// ====================================================================
const createGameContext = (state, roomId) => {
  // ====================================================================
  // --- SIGNAL HUB ---
  // ====================================================================

  class SignalHub {
    constructor() {
      this.channels = new Map();
      this.globalId = 1;
    }

    subscribe(entity, list) {
      list.forEach((ch) => {
        if (!this.channels.has(ch)) this.channels.set(ch, new Set());
        this.channels.get(ch).add(entity);
      });
    }

    unsubscribeFrom(entity, channel) {
      const subs = this.channels.get(channel);
      if (subs) {
        subs.delete(entity);
        if (subs.size === 0) this.channels.delete(channel);
      }
    }

    dispatch(sender, signal, data, target) {
      const deliver = (recipient) => {
        if (typeof recipient.receive === "function") {
          recipient.receive(signal, data, sender);
        }
      };

      if (target) {
        const subs = this.channels.get(target);
        if (subs) [...subs].forEach(deliver);
      } else if (sender && sender.channelsOut) {
        sender.channelsOut.forEach((ch) => {
          const subs = this.channels.get(ch);
          if (subs)
            [...subs].forEach((r) => {
              if (r !== sender) deliver(r);
            });
        });
      }
    }
  }
  // --- VARIABLES INTERNAS DEL MOTOR (No expuestas en 'state') ---
  let allEntities = [];
  let localEntityId = 1;
  let isUpdating = false;
  let pendingCleanup = new Set();
  const definitions = new Map();
  const hub = new SignalHub();
  const groupsMap = new Map();

  // --- MAPA MAESTRO (Persistencia en RAM) ---
  // Si venía del state guardado, lo restauramos, si no, nuevo Map
  const masterMap =
    state.masterMap instanceof Map
      ? state.masterMap
      : new Map(Object.entries(state.masterMap || {}));
  // Nota: JSON.stringify convierte Map a {}, al cargar hay que reconvertir o usar objeto plano.
  // Para simplificar persistencia JSON, usaremos un objeto plano interno si se prefiere,
  // pero aquí mantenemos Map por rendimiento en runtime.

  // ==========================================
  // LÓGICA DE BORRADO SEGURO
  // ==========================================
  function ejecutarBorradoReal(target) {
    const id = target.id;
    const g = target.grupo;
    if (!g) return;

    const idx = allEntities.findIndex((e) => e.id === id);
    if (idx > -1) allEntities.splice(idx, 1);

    if (state[g]) state[g] = state[g].filter((s) => s.id !== id);

    if (groupsMap.has(g)) {
      const groupSet = groupsMap.get(g);
      for (const ent of groupSet) {
        if (ent.id === id) {
          groupSet.delete(ent);
          break;
        }
      }
    }
  }

  // ==========================================
  // CLASE ENTITY (Interna)
  // ==========================================
  class Entity {
    constructor(
      grupo,
      varsIniciales,
      hub,
      onCanal = [],
      outCanal = [],
      destructedAutomatic = false
    ) {
      this.id = localEntityId++;
      this.grupo = grupo;
      this.hub = hub;
      this.vars = JSON.parse(JSON.stringify(varsIniciales || {}));

      // Canales
      this.channelsIn = [this.grupo, "global", ...onCanal];
      this.channelsOut = [this.grupo, "global", ...outCanal];
      this.writingAllowed = false;
      this.destructedAutomatic = destructedAutomatic;

      this.hub.subscribe(this, this.channelsIn);
    }

    vincularEstados(stateArray) {
      stateArray.push(this.vars);
    }

    setVar(k, v) {
      if (!this.writingAllowed) return;
      this.vars[k] = v;
    }

    deleteVar(k) {
      if (!this.writingAllowed) return;
      delete this.vars[k];
    }

    setDestructedAutomatic(v) {
      if (!this.writingAllowed) return;
      this.destructedAutomatic = !!v;
      if (this.destructedAutomatic && this.channelsIn.length === 0)
        this.selfDestruct();
    }

    pushChannel(tipo, nombre) {
      const target = tipo === "in" ? this.channelsIn : this.channelsOut;
      if (!target.includes(nombre)) {
        target.push(nombre);
        if (tipo === "in") this.hub.subscribe(this, [nombre]);
      }
    }

    deleteChannel(tipo, nombre) {
      if (tipo === "in") {
        this.channelsIn = this.channelsIn.filter((c) => c !== nombre);
        this.hub.unsubscribeFrom(this, nombre);
        if (this.destructedAutomatic && this.channelsIn.length === 0)
          this.selfDestruct();
      } else {
        this.channelsOut = this.channelsOut.filter((c) => c !== nombre);
      }
    }

    selfDestruct() {
      [...this.channelsIn].forEach((ch) => this.hub.unsubscribeFrom(this, ch));
      this.channelsIn = [];
      this.channelsOut = [];
      if (typeof Game !== "undefined" && Game.cleanup) {
        Game.cleanup(this);
      }
    }

    receive(s, d, e) {
      const def = definitions.get(this.grupo);
      const behavior = def ? def.logic : null;
      if (behavior && behavior[s]) {
        this.writingAllowed = true;
        try {
          behavior[s](this, d, e);
        } catch (err) {
          console.error(`Error en ${this.grupo}:`, err);
        }
        this.writingAllowed = false;
      }
    }

    emit(s, d, c) {
      if (c) this.hub.dispatch(this, s, d, c);
      else this.channelsOut.forEach((ch) => this.hub.dispatch(this, s, d, ch));
    }

    // --- NUEVO: EMITIR AL CLIENTE ---
    emitClient(event, data) {
      if (global.Game && global.Game.broadcast) {
        const payload = data || this.vars;
        global.Game.broadcast(event, payload);
      }
    }
  }

  // ==========================================
  // API DEL JUEGO (GameAPI)
  // ==========================================
  // Inicializar estado de pausa si no existe (Por defecto: NO pausado)
  if (typeof state.isPaused === "undefined") state.isPaused = false;
  const GameAPI = {
    get allEntities() {
      return allEntities;
    },

    // --- WORLD API (Gestión de Mapa) ---
    World: {
      setBlock: (tx, ty, instr) => {
        const key = `${tx},${ty}`;
        if (instr === null) {
          masterMap.delete(key); // <--- BORRADO REAL
        } else {
          masterMap.set(key, instr);
        }
      },
      getBlock: (tx, ty) => masterMap.get(`${tx},${ty}`),
      getArea: (tx, ty, radius = 15) => {
        const data = [];
        for (let y = ty - radius; y <= ty + radius; y++) {
          for (let x = tx - radius; x <= tx + radius; x++) {
            const block = masterMap.get(`${x},${y}`);
            if (block) data.push(x, y, block);
          }
        }
        return data;
      },
      // Exponer el mapa crudo para persistencia si es necesario
      _getMap: () => masterMap,
    },

    // --- NUEVOS MÉTODOS DE CONTROL DE FLUJO ---
    pause: () => {
      state.isPaused = true;
      console.log(`⏸️ Sala ${roomId} pausada.`);
    },
    resume: () => {
      state.isPaused = false;
      console.log(`▶️ Sala ${roomId} reanudada.`);
    },
    // Getter para que el loop sepa si debe correr
    get isRunning() {
      return !state.isPaused;
    },

    step: (dt) => {
      isUpdating = true;
      // 1. Ejecutar Tick Global
      allEntities.forEach((entity) => {
        // Aquí podrías optimizar con activeChunks si quisieras
        entity.receive("game_tick", dt);
      });
      isUpdating = false;

      // 2. Limpieza
      if (pendingCleanup.size > 0) {
        pendingCleanup.forEach((target) => ejecutarBorradoReal(target));
        pendingCleanup.clear();
      }
    },

    Actor: {
      define: (type, config, logic) => {
        definitions.set(type, { config, logic });
        if (!state[type]) state[type] = [];
        if (!groupsMap.has(type)) groupsMap.set(type, new Set());
      },
      getActorsByGrupo: (grupo) => {
        if (!groupsMap || !groupsMap.has(grupo)) return [];
        return Array.from(groupsMap.get(grupo));
      },
      create: (type, instVars = {}, autoDestruct = false) => {
        const def = definitions.get(type);
        if (!def) return { id: -1, error: true };

        const entity = new Entity(
          type,
          { ...def.config.vars, ...instVars },
          hub,
          def.config.onCanal || [],
          def.config.outCanal || [],
          autoDestruct
        );

        if (!state[type]) state[type] = [];
        entity.vincularEstados(state[type]);

        allEntities.push(entity);
        if (!groupsMap.has(type)) groupsMap.set(type, new Set());
        groupsMap.get(type).add(entity); // Guardamos la entidad directa para simplificar

        // Wrapper seguro para el usuario
        return {
          id: entity.id,
          grupo: entity.grupo,
          vars: entity.vars,
          setVar: (k, v) => entity.setVar(k, v),
          deleteVar: (k) => entity.deleteVar(k),
          pushChannel: (t, n) => entity.pushChannel(t, n),
          deleteChannel: (t, n) => entity.deleteChannel(t, n),
          selfDestruct: () => entity.selfDestruct(),
          emit: (s, d, c) => entity.emit(s, d, c),
          emitClient: (e, d) => entity.emitClient(e, d), // <--- EXPUESTO
          receive: (s, d, e) => entity.receive(s, d, e),
          setDestructedAutomatic: (v) => entity.setDestructedAutomatic(v),
        };
      },
    },

    cleanup: (target = null) => {
      if (!target) {
        allEntities = [];
        groupsMap.clear();
        return;
      }
      if (isUpdating) {
        pendingCleanup.add(target);
        return;
      }
      ejecutarBorradoReal(target);
    },

    BD: {
      save: async () => {
        // Serializamos el Map a Array para JSON
        const mapArray = Array.from(masterMap.entries());
        state.masterMap = mapArray; // Guardamos como array

        const json = JSON.stringify(state);
        await supabase
          .from("game_rooms")
          .update({ game_state_data: json })
          .eq("name", roomId);

        state.masterMap = masterMap; // Restauramos a Map para runtime
        console.log(`💾 [BD] Sala ${roomId} guardada.`);
      },
    },

    AI: async (prompt, model = "gemini-2.5-flash") => {
      try {
        const r = await genAI
          .getGenerativeModel({ model })
          .generateContent(prompt);
        return r.response.text();
      } catch (e) {
        return "Error IA";
      }
    },

    Bot: {
      create: (config) => {
        if (!state._sys) state._sys = { spawnQueue: [] };
        state._sys.spawnQueue.push({ config });
        return "pending";
      },
    },

    broadcast: (signal, data) => {
      io.to(roomId).emit(signal, data);
    },

    emit: (sig, dat, ch) => hub.dispatch(null, sig, dat, ch || "global"),
  };

  global.Game = GameAPI;
  return { GameAPI, EntityClass: Entity, allEntitiesRef: allEntities };
};

// ====================================================================
// --- 3. COMPILADOR ---
// ====================================================================
function compileLogic(serverLogic, initialState, roomId) {
  if (!initialState) initialState = {};

  // Recuperar mapa si viene como array (desde JSON BD)
  if (Array.isArray(initialState.masterMap)) {
    initialState.masterMap = new Map(initialState.masterMap);
  }

  const { GameAPI, EntityClass, allEntitiesRef } = createGameContext(
    initialState,
    roomId
  );

  const sandbox = {
    state: initialState,
    World: GameAPI.World,
    Entity: EntityClass,
    Game: GameAPI,
    Actor: GameAPI.Actor,
    BD: GameAPI.BD,
    AI: GameAPI.AI,
    Bot: GameAPI.Bot,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Math,
  };

  const code = `
        try { ${serverLogic || ""} } catch(e) { 
            console.error("❌ Error en Lógica Usuario:", e.message);
            throw e; 
        }
        ({
            onInput: (typeof onInput !== 'undefined' ? onInput : null)
        })
    `;

  try {
    const userLogic = new vm.Script(code).runInNewContext(sandbox);
    return {
      userLogic,
      state: initialState,
      GameAPI,
      allEntities: allEntitiesRef,
    };
  } catch (e) {
    console.error("🚨 Error compilando sala:", e.message);
    return {
      userLogic: { onInput: () => {} },
      state: initialState,
      GameAPI,
      allEntities: allEntitiesRef,
    };
  }
}

// ====================================================================
// --- 4. LOOP & SOCKETS ---
// ====================================================================
io.on("connection", (socket) => {
  // 1. GESTIÓN DE SALAS (Infraestructura básica)
  socket.on("join_room", async (roomId, userName) => {
    socket.join(roomId);
    socket.roomId = roomId;
    // Solo guardamos el userId para logs de consola, no para lógica del juego
    socket.userId = userName || socket.id;
    console.log(`👤 Conectado: ${socket.userId} a ${roomId}`);

    // Cancelar hibernación si la sala estaba durmiendo
    if (rooms[roomId] && rooms[roomId].hibernationTimeout) {
      console.log(`⚡ Cancelando hibernación de ${roomId}.`);
      clearTimeout(rooms[roomId].hibernationTimeout);
      delete rooms[roomId].hibernationTimeout;
    }

    // Cargar datos de Supabase si la sala no existe en memoria
    const { data } = await supabase
      .from("game_rooms")
      .select("*")
      .eq("name", roomId)
      .single();

    let loadedState = {};
    if (data?.game_state_data) {
      try {
        loadedState = JSON.parse(data.game_state_data);
      } catch (e) {}
    }

    // Inicializar la sala si es nueva
    if (!rooms[roomId]) {
      const compiled = compileLogic(
        data?.server_logic || "",
        loadedState,
        roomId
      );
      rooms[roomId] = { ...compiled, inputQueue: [] };

      // BUCLE DE JUEGO (GAME LOOP)
      rooms[roomId].interval = setInterval(() => {
        const r = rooms[roomId];
        if (!r || !r.GameAPI) return;

        try {
          // PROCESAR INPUTS (Ahora llegan crudos desde el cliente)
          while (r.inputQueue.length > 0) {
            const input = r.inputQueue.shift();
            try {
              if (r.userLogic.onInput) r.userLogic.onInput(input, r.state);
            } catch (e) {
              console.error("Input Error:", e.message);
            }
          }

          // SPAWNS (Legacy)
          if (r.state._sys && r.state._sys.spawnQueue) {
            while (r.state._sys.spawnQueue.length > 0) {
              const req = r.state._sys.spawnQueue.shift();
              r.GameAPI.Actor.create(req.config.type || "Bot", req.config);
            }
          }

          // UPDATE FÍSICO
          if (r.GameAPI.isRunning) r.GameAPI.step(0.016);
        } catch (e) {
          console.error(`Error Loop ${roomId}:`, e);
        }
      }, 16);
    }
  });

  // 2. EL DESEMPAQUETADOR (Reemplaza a onAny)
  socket.on("client_tick", (packet) => {
    // Validación básica
    if (!socket.roomId || !rooms[socket.roomId]) return;
    const r = rooms[socket.roomId];

    // A. DESEMPAQUETAR MOVIMIENTO ('m')
    // El cliente envió { m: { id: 'aldo', x: 10, y: 20, vx: 1... } }
    // Nosotros lo convertimos en type: 'action_move'
    if (packet.m) {
      r.inputQueue.push({
        type: "action_move",
        ...packet.m,
      });
    }

    // B. DESEMPAQUETAR ACCIONES ('a')
    // El cliente envió { a: [ { type: 'shoot_event', payload: {...} }, ... ] }
    if (packet.a && Array.isArray(packet.a)) {
      packet.a.forEach((action) => {
        r.inputQueue.push({
          type: action.type,
          ...action.payload,
        });
      });
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const roomSockets = io.sockets.adapter.rooms.get(roomId);
    const numClients = roomSockets ? roomSockets.size : 0;
    // 3. DESCONEXIÓN
    socket.on("disconnect", () => {
      // Opcional: Avisar que se fue
      if (socket.roomId && rooms[socket.roomId]) {
        rooms[socket.roomId].inputQueue.push({
          type: "player_leave",
          id: socket.userId,
        });
      }
    });
    if (numClients === 0) {
      console.log(`⏳ ${roomId} vacía. Hibernando en 10s...`);
      rooms[roomId].hibernationTimeout = setTimeout(async () => {
        const currentSockets = io.sockets.adapter.rooms.get(roomId);
        if (currentSockets && currentSockets.size > 0) return;

        try {
          const r = rooms[roomId];
          clearInterval(r.interval);

          // Persistencia: Convertir Map a Array para JSON
          const mapArray = Array.from(r.GameAPI.World._getMap().entries());
          r.state.masterMap = mapArray;

          const jsonState = JSON.stringify(r.state);
          await supabase
            .from("game_rooms")
            .update({ game_state_data: jsonState })
            .eq("name", roomId);

          delete rooms[roomId];
          console.log(`💤 ${roomId} hibernada y guardada.`);
        } catch (err) {
          console.error(`❌ Error hibernando ${roomId}:`, err);
        }
      }, 10000);
    }
  });
});

// ====================================================================
// --- 5. API ROUTES ---
// ====================================================================
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
    // Hot Reload
    rooms[roomId].state = {}; // Limpieza agresiva para evitar conflictos de variables viejas
    if (!rooms[roomId].state.masterMap)
      rooms[roomId].state.masterMap = new Map(); // Mantener mapa si se desea o reiniciar

    const c = compileLogic(serverLogic, rooms[roomId].state, roomId);
    rooms[roomId].userLogic = c.userLogic;
    rooms[roomId].GameAPI = c.GameAPI;
    rooms[roomId].allEntities = c.allEntities;
    console.log(`🔥 ${roomId} recargada.`);
  }

  io.to(roomId).emit("design_update", {
    structure: clientStructureHtml,
    renderScript: clientRenderScript,
    inputScript: clientInputScript,
  });

  res.json({ ok: true });
});

app.post("/api/ai/generate", async (req, res) => {
  try {
    const r = await genAI
      .getGenerativeModel({ model: req.body.model || "gemini-2.5-flash" })
      .generateContent(req.body.prompt);
    res.send({ success: true, response: r.response.text() });
  } catch (e) {
    res.status(500).send({ success: false, error: e.message });
  }
});

app.post("/api/reset-room-state", async (req, res) => {
  try {
    const { roomId } = req.body;
    await supabase
      .from("game_rooms")
      .update({ game_state_data: {} })
      .eq("name", roomId);

    if (rooms[roomId]) {
      rooms[roomId].state = { masterMap: new Map() };
      if (rooms[roomId].allEntities) rooms[roomId].allEntities.length = 0;
      console.log(`🧹 ${roomId} reseteada.`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
