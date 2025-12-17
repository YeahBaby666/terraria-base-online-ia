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
const SUPABASE_URL =
  process.env.SUPABASE_URL || "SUPABASE_URL";
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  "SUPABASE_KEY";

// Configuración de Gemini
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "GEMINI_API_KEY";
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

// --- FUNCIONES CORE ---

function compileLogic(serverLogic, initialState, roomId) {
  if (!initialState._sys) {
    Object.defineProperty(initialState, "_sys", {
      value: { spawnQueue: [], killQueue: [] },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  const sandbox = {
    state: initialState,
    console: console,
    API_BASE_URL: API_BASE_URL,
    // INYECTAMOS LA LIBRERÍA CON EL NOMBRE 'fetch'
    // Esto hace que 'fetch' sea una función nativa DENTRO del sandbox
    fetch: nodeFetch,
    // Definimos la función AI aquí mismo para que use el 'fetch' del sandbox
    AI: async function (prompt, model = "gemini-2.5-flash") {
      const url = `${API_BASE_URL}/api/ai/generate`;
      try {
        const response = await this.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, model }),
        });
        const data = await response.json();

        // Si el servidor mandó un error, devolvemos el mensaje de error en lugar de undefined
        return data.response || data.error || "Error desconocido";
      } catch (e) {
        return "Error de red: " + e.message;
      }
    },
    Bot: {
      create: (config) => {
        const id = "bot_" + Math.random().toString(36).substr(2, 7);
        if (!initialState._sys)
          initialState._sys = { spawnQueue: [], killQueue: [] };
        initialState._sys.spawnQueue.push({ id, config });
        return id;
      },
      destroy: (id) => {
        if (initialState._sys) initialState._sys.killQueue.push(id);
      },
    },
  };

  // Hacemos que AI sea tanto función como objeto con .generate
  const scriptCode =
    `
        AI.generate = AI.bind(this); 
    ` +
    serverLogic +
    `\n;({
        onUpdate: (typeof onUpdate!=='undefined'?onUpdate:null), 
        onInput: (typeof onInput!=='undefined'?onInput:null),
        onBot: (typeof onBot!=='undefined'?onBot:null)
    })`;
  try {
    const userLogic = new vm.Script(scriptCode).runInNewContext(sandbox);
    return { userLogic, state: sandbox.state };
  } catch (e) {
    console.error("Error de compilación:", e.message);
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

    // 1. INICIALIZAR SALA SI NO EXISTE
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

      // *** CAMBIO CLAVE AQUÍ: Pasar el roomId a compileLogic ***
      const { userLogic, state: newState } = compileLogic(
        roomData.server_logic,
        initialState,
        roomId
      );

      rooms[roomId] = {
        inputQueue: [], // <--- NUEVA COLA DE SECUENCIAS
        state: newState,
        logic: userLogic,
        ownerId: roomData.owner_id,
        players: new Set(),
        bots: new Map(), // CAMBIO: Usamos un Map para acceso rápido por ID
        interval: null,
      };

      // GAME LOOP PROFESIONAL
      rooms[roomId].interval = setInterval(() => {
        const r = rooms[roomId];

        try {
          // 1. PROCESAR SECUENCIA DE INPUTS (Array)
          // Procesamos todos los inputs acumulados en este tick uno por uno
          while (r.inputQueue.length > 0) {
            const input = r.inputQueue.shift(); // Sacamos el más antiguo (FIFO)
            if (r.logic.onInput) {
              r.logic.onInput(input, r.state);
            }
          }

          // 2. UPDATE DE FÍSICA (Ahora con los inputs ya aplicados)
          if (r.logic.onUpdate) r.logic.onUpdate(r.state, 0.016);

          // 1. GESTIÓN DE BOTS (SPAWN/DESPAWN)
          // Procesar cola de nacimientos
          if (r.state._sys && r.state._sys.spawnQueue.length > 0) {
            const queue = r.state._sys.spawnQueue;
            while (queue.length > 0) {
              const req = queue.shift(); // Sacar el primero
              // Crear memoria del bot ("Virtual Client")
              r.bots.set(req.id, {
                myId: req.id,
                config: req.config || {},
                memory: {}, // Memoria persistente para la IA (timers, targets)
              });
              // Crear cuerpo en el estado del juego inmediatamente
              if (!r.state.jugadores_data) r.state.jugadores_data = {};
              r.state.jugadores_data[req.id] = {
                id: req.id,
                x: req.config.x || 0,
                y: req.config.y || 0,
                ...req.config, // Mezclar config extra
              };
            }
          }

          // Procesar cola de muertes
          if (r.state._sys && r.state._sys.killQueue.length > 0) {
            const queue = r.state._sys.killQueue;
            while (queue.length > 0) {
              const botId = queue.shift();
              r.bots.delete(botId); // Eliminar procesador
              if (r.state.jugadores_data) delete r.state.jugadores_data[botId]; // Eliminar cuerpo
            }
          }

          // 2. CICLO UPDATE (Física global)
          if (r.logic.onUpdate) r.logic.onUpdate(r.state, 0.033);

          // 3. CICLO DE BOTS (IA -> INPUT)
          if (r.logic.onBot && r.logic.onInput) {
            for (const [botId, botData] of r.bots) {
              // Ejecutar la IA del bot (onBot)
              // Retorna una acción simulada (ej: { type: 'move', vx: 1 })
              const action = r.logic.onBot(
                r.state,
                botData.memory,
                botData.config
              );

              if (action) {
                action.id = botId; // Firmar la acción como este bot
                r.logic.onInput(action, r.state); // Inyectar como input "real"
              }
            }
          }

          // 4. EMITIR ESTADO
          io.to(roomId).emit("state_update", r.state);
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
