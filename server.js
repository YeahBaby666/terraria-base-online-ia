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
// --- 1. SIGNAL HUB ---
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

  // DESCONEXIÓN DE UN SOLO CANAL
  unsubscribeFrom(entity, channel) {
    const subs = this.channels.get(channel);
    if (subs) {
      subs.delete(entity);
      // Si el canal queda vacío, lo eliminamos para ahorrar RAM
      if (subs.size === 0) this.channels.delete(channel);
    }
  }

  dispatch(sender, signal, data, target) {
    const deliver = (recipient) => {
      // Ya no chequeamos isDead, solo si puede recibir
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
// ====================================================================
// --- 2. GAME CONTEXT ---
// ====================================================================
const createGameContext = (state, renderState, roomId) => {
  // 2. VARIABLES GLOBALES DE APOYO
  let allEntities = []; // Lista maestra para el cleanup
  let localEntityId = 1;
  const definitions = new Map(); // <--- AÑADE ESTA LÍNEA AQUÍ
  const hub = new SignalHub();

  class Entity {
    // AHORA RECIBE: onCanal (Entrada) y outCanal (Salida)
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
      this.renderData = {
        id: this.id,
        grupo: this.grupo,
        ...this.vars,
      };

      // --- CANALES DE ENTRADA (Suscripciones) ---
      // 1. Su propio grupo (siempre escucha a sus pares).
      // 2. 'global' (siempre escucha al Game/Dios).
      // 3. onCanal (definidos por el usuario).
      this.channelsIn = [this.grupo, "global", ...onCanal];

      // --- CANALES DE SALIDA (Despacho) ---
      // 1. Su propio grupo.
      // 2. 'global' (puede gritarle a todos).
      // 3. outCanal (definidos por el usuario).
      this.channelsOut = [this.grupo, "global", ...outCanal];

      this.writingAllowed = false;
      this.destructedAutomatic = destructedAutomatic;

      // Solo nos suscribimos a los de ENTRADA
      this.hub.subscribe(this, this.channelsIn);
    }

    /**
     * Sincroniza explícitamente el estado de la sala con esta instancia.
     * Se usa en el Actor.create justo después de instanciar.
     */
    vincularEstados(stateArray, renderArray) {
      stateArray.push(this.vars);
      renderArray.push(this.renderData);
    }

    // --- MODIFICADORES (Sincronización por Referencia) ---
    // Al modificar this.vars[k], se actualiza automáticamente el objeto dentro del array del state

    setVar(k, v, r = true) {
      if (!this.writingAllowed) return;
      this.vars[k] = v;
      if (r) this.renderData[k] = v;
    }

    deleteVar(k, r = true) {
      if (!this.writingAllowed) return;
      delete this.vars[k];
      if (r) delete this.renderData[k];
    }

    setRender(k, v, r = false) {
      if (!this.writingAllowed) return;
      this.renderData[k] = v;
      if (r) this.vars[k] = v;
    }

    deleteRender(k, r = false) {
      if (!this.writingAllowed) return;
      delete this.renderData[key];
      if (reflect) delete this.vars[key];
    }

    setDestructedAutomatic(v) {
      if (!this.writingAllowed) return;
      this.destructedAutomatic = !!v;
      if (this.destructedAutomatic && this.channelsIn.length === 0)
        this.selfDestruct();
    }

    // --- CANALES Y DESTRUCCIÓN ---
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
      // Aislamiento
      [...this.channelsIn].forEach((ch) => this.hub.unsubscribeFrom(this, ch));
      this.channelsIn = [];
      this.channelsOut = [];

      // Eliminación quirúrgica del GameAPI
      if (typeof Game !== "undefined" && Game.cleanup) {
        Game.cleanup(this);
      }
    }

    // --- CEREBRO Y RED ---

    // Solo aseguramos que receive busque en definitions global
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
  }

  const GameAPI = {
    Actor: {
      // AHORA: 'type' es el identificador único y el nombre del grupo en el state
      define: (type, config, logic) => {
        // Guardamos la definición usando el 'type' como clave
        definitions.set(type, { config, logic });

        // Inicializamos los arrays en el state inmediatamente con ese nombre
        if (!state[type]) state[type] = [];
        if (!renderState[type]) renderState[type] = [];
      },
      create: (type, instVars = {}, autoDestruct = false) => {
        const def = definitions.get(type);
        if (!def) {
          console.warn(
            `⚠️ ADVERTENCIA: Intentaste crear el actor '${type}', pero no existe.`
          );
          console.warn(
            `   ¿Quizás cambiaste el nombre en .define() y olvidaste el .create()?`
          );
          // Retornamos un objeto "Dummy" inofensivo para que el código siguiente no falle
          return {
            id: -1,
            setVar: () => {},
            emit: () => {},
            error: true,
          };
        }

        // --- EXTRACCIÓN DE CANALES ---
        const onList = def.config.onCanal || [];
        const outList = def.config.outCanal || [];

        // Instanciar pasando las dos listas
        const entity = new Entity(
          type, // <--- AQUÍ ESTÁ EL CAMBIO: El tipo ES el grupo
          { ...def.config.vars, ...instVars },
          hub,
          onList,
          outList,
          autoDestruct
        );

        // Wrapper de Seguridad (Mapeo)
        const wrapper = {
          id: entity.id,
          grupo: entity.grupo,
          vars: entity.vars,
          renderData: entity.renderData,
          setVar: (k, v, r) => entity.setVar(k, v, r),
          deleteVar: (k, r) => entity.deleteVar(k, r),
          setRender: (k, v, r) => entity.setRender(k, v, r),
          deleteRender: (k, r) => entity.deleteRender(k, r),
          pushChannel: (t, n) => entity.pushChannel(t, n),
          deleteChannel: (t, n) => entity.deleteChannel(t, n),
          selfDestruct: () => entity.selfDestruct(),
          emit: (s, d, c) => entity.emit(s, d, c),
          receive: (s, d, e) => entity.receive(s, d, e),
          setDestructedAutomatic: (v) => entity.setDestructedAutomatic(v),
        };

        entity.vincularEstados(state[type], renderState[type]);
        allEntities.push(entity);

        return wrapper;
      },
    },
    // FUNCIÓN DE LIMPIEZA MANUAL (Invocable desde la lógica)
    /**
     * Limpieza selectiva o general
     * @param {Entity} target - (Opcional) La entidad a eliminar específicamente
     */
    cleanup: (target = null) => {
      try {
        if (target) {
          // --- ELIMINACIÓN QUIRÚRGICA ---
          const g = target.grupo;

          // Validamos que el grupo exista en el state antes de filtrar
          if (state && state[g]) {
            state[g] = state[g].filter((v) => v !== target.vars);
          }

          // Validamos que el grupo exista en el renderState antes de filtrar
          if (renderState && renderState[g]) {
            renderState[g] = renderState[g].filter(
              (r) => r !== target.renderData
            );
          }

          // Eliminar de la lista maestra global de la sala
          allEntities = allEntities.filter((e) => e !== target);
        } else {
          // --- LIMPIEZA GENERAL (BASURA) ---
          // Solo consideramos "vivos" a los que tienen canales de entrada
          const vivos = allEntities.filter(
            (e) => e.channelsIn && e.channelsIn.length > 0
          );
          const idsVivos = new Set(vivos.map((e) => e.id));

          Object.keys(state).forEach((grupo) => {
            if (Array.isArray(state[grupo])) {
              state[grupo] = state[grupo].filter((vars) => {
                const ent = allEntities.find((e) => e.vars === vars);
                return ent && idsVivos.has(ent.id);
              });
            }

            // Seguridad crítica: solo filtramos si renderState[grupo] es un Array
            if (renderState[grupo] && Array.isArray(renderState[grupo])) {
              renderState[grupo] = renderState[grupo].filter((render) =>
                idsVivos.has(render.id)
              );
            }
          });

          allEntities = vivos;
        }
      } catch (err) {
        console.error("❌ Error en cleanup quirúrgico:", err.message);
      }
    },
    getBehavior: (grupo) => {
      const def = definitions.get(grupo);
      return def ? def.logic : null;
    },
    // --- PILAR 2: BD (Persistencia) ---
    BD: {
      save: async () => {
        const json = JSON.stringify(state);
        await supabase
          .from("game_rooms")
          .update({ game_state_data: json })
          .eq("name", roomId);
        console.log(`💾 [BD] Sala ${roomId} guardada.`);
      },
    },

    // --- PILAR 3: IA ---
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

    // --- PILAR 4: BOT ---
    Bot: {
      create: (config) => {
        state._sys.spawnQueue.push({ config });
        return "pending";
      },
    },
    // ... otros métodos
    broadcast: (signal, data) => {
      io.to(roomId).emit(signal, data);
    },

    emit: (sig, dat, ch) => hub.dispatch(null, sig, dat, ch || "global"),
  };
  // IMPORTANTE: Para que la clase Entity (que es global) vea a Game
  global.Game = GameAPI;
  // Devolvemos también allEntities y la clase Entity para que el compilador las use
  return { GameAPI, EntityClass: Entity, allEntitiesRef: allEntities };
};

// ====================================================================
// --- 3. COMPILADOR ---
// ====================================================================
function compileLogic(serverLogic, initialState, roomId) {
  if (!initialState) initialState = {};
  if (!initialState._sys) initialState._sys = { spawnQueue: [] };
  // 1. Crear el contenedor vacío para el render
  let renderState = {};

  // Obtenemos el contexto aislado
  const { GameAPI, EntityClass, allEntitiesRef } = createGameContext(
    initialState,
    renderState,
    roomId
  );

  const sandbox = {
    state: initialState,
    renderState,
    Entity: EntityClass, // <--- Usamos la clase local
    Game: GameAPI,
    Actor: GameAPI.Actor,
    BD: GameAPI.BD,
    AI: GameAPI.AI,
    Bot: GameAPI.Bot, // --- INYECTAR FUNCIONES DE TIEMPO ---
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Math,
  };

  const code = `
        try { ${
          serverLogic || ""
        } } catch(e) { // Esto captura errores síncronos al EJECUTAR el script por primera vez
            console.error("❌ Error de Sintaxis/Ejecución inicial en Lógica Usuario:", e.message);
            throw e; // Relanzamos para que lo capture el bloque de abajo
        }
        ({
            onUpdate: (typeof onUpdate !== 'undefined' ? onUpdate : null),
            onInput: (typeof onInput !== 'undefined' ? onInput : null)
        })
    `;

  try {
    const userLogic = new vm.Script(code).runInNewContext(sandbox);
    // 3. RETORNAR TODO EL PAQUETE (Incluyendo el renderState)
    return {
      userLogic,
      state: initialState,
      renderState, // <--- FUNDAMENTAL: Ahora join_room podrá guardarlo
      GameAPI,
      allEntities: allEntitiesRef, // Devolvemos la referencia para el loop principal
    };
  } catch (e) {
    console.error("🚨 LA SALA NO SE ACTUALIZÓ POR ERROR DE CÓDIGO 🚨");
    console.error(e.message);

    // 🛡️ BLINDAJE 3: Devolver lógica vacía segura en lugar de romper
    return {
      userLogic: {
        onUpdate: () => {}, // Función vacía
        onInput: () => {}, // Función vacía
      },
      state: initialState,
      renderState,
      GameAPI,
      allEntities: allEntitiesRef,
    };
  }
}

// ====================================================================
// --- 4. LOOP & SOCKETS ---
// ====================================================================
io.on("connection", (socket) => {
  socket.on("join_room", async (roomId, userName) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userName || socket.id; // También asegura el ID
    console.log(`👤 Usuario conectado: ${socket.userId} en sala ${roomId}`);
    // --- AÑADIR ESTO: CANCELAR HIBERNACIÓN ---
    if (rooms[roomId] && rooms[roomId].hibernationTimeout) {
      console.log(
        `⚡ Cliente reconectado. Cancelando hibernación de ${roomId}.`
      );
      clearTimeout(rooms[roomId].hibernationTimeout);
      delete rooms[roomId].hibernationTimeout;
    }
    const { data } = await supabase
      .from("game_rooms")
      .select("*")
      .eq("name", roomId)
      .single();
    let loadedState = {};
    if (data?.game_state_data)
      try {
        loadedState = JSON.parse(data.game_state_data);
      } catch (e) {}

    if (!rooms[roomId]) {
      const compiled = compileLogic(
        data?.server_logic || "",
        loadedState,
        roomId
      );
      rooms[roomId] = { ...compiled, inputQueue: [] };

      rooms[roomId].interval = setInterval(() => {
        const r = rooms[roomId];
        try {
         
          // 1. PROCESAR INPUTS
          while (r.inputQueue.length > 0) {
            const input = r.inputQueue.shift();
            // Ahora esto NO será undefined
            console.log("Procesando input:", input.type, "de", input.id);
            if (r.userLogic.onInput) r.userLogic.onInput(input, r.state);
          }

          // 2. PROCESAR SPAWNS DE BOTS
          while (r.state._sys.spawnQueue.length > 0) {
            const req = r.state._sys.spawnQueue.shift();
            r.GameAPI.Actor.create(req.config.type || "Bot", req.config);
          }

          // 3. UPDATE DE LÓGICA (Usuario)
          if (r.userLogic.onUpdate) r.userLogic.onUpdate(r.state, 0.016);
          // B. Lógica individual de cada entidad (MOVIMIENTO REAL)
          r.allEntities.forEach((ent) => {
            if (ent.receive) {
              ent.receive("onUpdate", 0.016);
            }
          });

          // 4. EMITIR SOLO EL RENDER STATE (Privacidad asegurada)
          // r.state se queda en el servidor para la BD.
          io.to(roomId).emit("render_update", r.renderState);
        } catch (e) {
          console.error(`Error en Loop de sala ${roomId}:`, e);
        }
      }, 16);
    }
  });

  socket.on("client_tick", (packet) => {
    if (!socket.roomId || !rooms[socket.roomId]) return;
    const r = rooms[socket.roomId];
    const pid = socket.userId || socket.id;

    console.log("📥 Paquete recibido de cliente ACTIONS:", packet.actions);
    console.log("----------");
    console.log("----------");

    // 1. Si el paquete viene con la estructura del ClientEngine (actions[])
    if (packet.actions && Array.isArray(packet.actions)) {
      packet.actions.forEach((a) => {
        // "Aplanamos" el objeto para que el servidor reciba
        // directamente el tipo y el payload
        r.inputQueue.push({
          type: a.type,
          ...a.payload, // <--- Importante: Metemos el contenido de payload al nivel superior
          id: pid,
          timestamp: Date.now(),
        });
      });
    }

    // 2. Si es un movimiento (packet.move)
    else if (packet.move) {
      r.inputQueue.push({
        type: "player_move",
        ...packet.move,
        id: pid,
      });
    }

    // C. CORRECCIÓN: Si NO tiene forma (Dato puro o amorfo)
    if (!packet.move && !packet.actions) {
      console.log("📦 Procesando paquete amorfo de:", pid);

      // Lo normalizamos como una acción de tipo 'raw'
      // Esto permite que el onInput del editor lo reciba sin romperse
      r.inputQueue.push({
        type: "raw_data",
        payload: packet, // El dato tal cual llegó
        id: pid,
      });
    }

    // 3. Log de depuración para ver que entró a la cola REAL
    console.log(`📥 Cola actualizada: ${r.inputQueue.length} items.`);
    console.log("----------");
  });
  // ==================================================================
  // --- SISTEMA DE LIMPIEZA AUTOMÁTICA (AUTO-HIBERNACIÓN) ---
  // ==================================================================
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    // 1. Contar cuántos quedan en la sala
    // Nota: socket.io a veces tarda ms en actualizar, así que pedimos el tamaño real
    const roomSockets = io.sockets.adapter.rooms.get(roomId);
    const numClients = roomSockets ? roomSockets.size : 0;

    console.log(`🔌 Usuario desconectado de ${roomId}. Quedan: ${numClients}`);

    if (numClients === 0) {
      console.log(
        `⏳ Sala ${roomId} vacía. Iniciando cuenta atrás para hibernación...`
      );

      // 2. Damos 10 segundos de gracia por si fue un F5 (recarga)
      // Guardamos el timeout en el objeto de la sala para poder cancelarlo si alguien entra
      rooms[roomId].hibernationTimeout = setTimeout(async () => {
        // Verificación doble por seguridad (¿Entró alguien en estos 10 seg?)
        const currentSockets = io.sockets.adapter.rooms.get(roomId);
        if (currentSockets && currentSockets.size > 0) {
          console.log(
            `🚫 Hibernación cancelada. Alguien volvió a entrar a ${roomId}.`
          );
          return;
        }

        // --- AHORA SÍ: APAGÓN ---
        try {
          const r = rooms[roomId];

          // A. Detener el Loop de Juego (Ahorra CPU)
          clearInterval(r.interval);

          // B. Guardar Estado final en Supabase (Persistencia)
          // Nota: Guardamos 'state' (lógica), no renderState
          const jsonState = JSON.stringify(r.state);
          await supabase
            .from("game_rooms")
            .update({ game_state_data: jsonState })
            .eq("name", roomId);
          // AL ELIMINAR EL OBJETO ROOM, EL GARBAGE COLLECTOR DE JS
          // ELIMINARÁ TAMBIÉN EL 'allEntities' LOCAL Y LAS DEFINICIONES.
          // ¡LIMPIEZA PERFECTA!
          delete rooms[roomId];
          console.log(`💤 Sala ${roomId} eliminada de RAM.`);
          console.log(`💾 Estado de ${roomId} guardado en DB.`);

                    
          // 2. Borrar el objeto de la sala completo
          delete rooms[roomId];

          console.log(
            `💤 Sala ${roomId} eliminada de la RAM (Hibernación completa).`
          );
        } catch (err) {
          console.error(`❌ Error hibernando sala ${roomId}:`, err);
        }
      }, 10000); // 10 segundos de espera
    }
  });
});

// ====================================================================
// --- 5. API PUBLISH (CORREGIDO: EMISIÓN SOCKET) ---
// ====================================================================
app.post("/api/publish-room", async (req, res) => {
  const {
    roomId,
    serverLogic,
    clientStructureHtml,
    clientRenderScript,
    clientInputScript,
  } = req.body;

  // 1. Guardar en Base de Datos
  await supabase
    .from("game_rooms")
    .update({
      server_logic: serverLogic,
      client_structure_html: clientStructureHtml,
      client_render_script: clientRenderScript,
      client_input_script: clientInputScript,
    })
    .eq("name", roomId);

  // 2. Actualizar Lógica del Servidor en Caliente (Hot Swap)
  if (rooms[roomId]) {
    // Limpieza forzada de memoria
    rooms[roomId].state = { _sys: { spawnQueue: [] } };
    rooms[roomId].renderState = {};
    // Recompilamos manteniendo el State actual para no reiniciar la partida
    const c = compileLogic(serverLogic, rooms[roomId].state, roomId);

    // Actualizamos las referencias de la sala
    rooms[roomId].userLogic = c.userLogic;
    rooms[roomId].GameAPI = c.GameAPI;
    rooms[roomId].allEntities = c.allEntities; // Actualizamos la referencia al nuevo array vacío
    // Nota: GameAPI se mantiene o se recrea según necesidad,  lo simplificaaquímos manteniendo el state
    console.log(`🔥 Sala ${roomId} recargada.`);
  }

  // 3. ACTUALIZAR CLIENTES CONECTADOS (Hot Reload)
  // Esto es lo que faltaba para que el HTML reciba el evento y llame a injectScripts
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
// --- Añade este endpoint en tu server.js ---

app.post("/api/reset-room-state", async (req, res) => {
  

  try {
    const { roomId } = req.body;
    // 1. Limpiar en Supabase
    const { error } = await supabase
      .from("game_rooms")
      .update({ game_state_data: {} }) // O "{}" según prefieras
      .eq("name", roomId);

    if (error) throw error;

    // 2. Limpiar en Memoria (si la sala está abierta)
    if (rooms[roomId]) {
      rooms[roomId].state = { _sys: { spawnQueue: [] } };
      rooms[roomId].renderState = {};
      // Al vaciar la sala así, técnicamente deberíamos vaciar el allEntities local
      // La forma más fácil es recompilar (Publish) o iterar sobre rooms[roomId].allEntities y vaciarlo.
      if(rooms[roomId].allEntities) rooms[roomId].allEntities.length = 0;
      console.log(
        `🧹 [SISTEMA] State de sala ${roomId} reseteado por el usuario.`
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Error reseteando sala:", e);
    res.status(500).json({ error: e.message });
  }
});
