const { Server } = require("socket.io");
const { createClient } = require('@supabase/supabase-js');
const vm = require('vm');
const express = require('express');
const bodyParser = require('body-parser');
const { GoogleGenAI } = require('@google/genai'); 
const fetch = require('node-fetch'); // Usaremos 'node-fetch' para las llamadas internas API si es necesario

// ====================================================================
// --- CONFIGURACIÓN DE ACCESO Y VARIABLES DE ENTORNO ---
// ====================================================================

// Base URL para los endpoints de la API de este servidor Node.js
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Configuración de Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uucetvaiesfwuxmwukvg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1Y2V0dmFpZXNmd3V4bXd1a3ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU3MzEzMjUsImV4cCI6MjA4MTMwNzMyNX0.B6abitvRPUeZPPFUiqYhXf0MsBx2bRpJMz3wPgyKfbE';

// Configuración de Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'TU_API_KEY_AQUI'; 
const ai = new GoogleGenAI(GEMINI_API_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Inicializar Express para manejar la API HTTP (Publicación)
const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000; // Render establece process.env.PORT automáticamente

const httpServer = app.listen(PORT, () => {
    console.log(`🚀 Servidor HTTP/API y Sockets iniciado en puerto ${PORT}`);
});

const io = new Server(httpServer, { cors: { origin: "*" } });
const rooms = {}; // Memoria: { 'id': { state, logic, bots:[], players:Set, ownerId, interval } }

// --- FUNCIONES CORE ---

/**
 * Compila la lógica del servidor (JS) en un sandbox seguro.
 * Utiliza variables de entorno para las URLs de la API interna.
 */
function compileLogic(serverLogic, initialState, roomId) {
    const sandbox = { 
        state: initialState,
        
        // --- API DE BASE DE DATOS REAL (Usando API_BASE_URL) ---
        DB: { 
            saveState: async (stateToSave) => {
                const url = `${API_BASE_URL}/api/game-state/save`; // <-- USANDO VARIABLE
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ roomId: roomId, gameStateData: stateToSave })
                    });
                    if (!response.ok) throw new Error(`DB Save failed: ${response.statusText}`);
                    return await response.json();
                } catch (e) {
                    console.error(`[Sandbox DB Error] Failed to save state for ${roomId}:`, e.message);
                    return { success: false, error: e.message };
                }
            },
            loadState: async () => {
                const url = `${API_BASE_URL}/api/game-state/load/${roomId}`; // <-- USANDO VARIABLE
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`DB Load failed: ${response.statusText}`);
                    const data = await response.json();
                    return data.gameStateData;
                } catch (e) {
                    console.error(`[Sandbox DB Error] Failed to load state for ${roomId}:`, e.message);
                    return null;
                }
            }
        },
        // --- API DE IA REAL (Usando API_BASE_URL) ---
        AI: { 
            generate: async(prompt, model='gemini-2.5-flash') => {
                const url = `${API_BASE_URL}/api/ai/generate`; // <-- USANDO VARIABLE
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt, model })
                });
                if (!response.ok) throw new Error(`AI API call failed: ${response.statusText}`);
                const data = await response.json();
                return data.response;
            }
        },
        console: console 
    };
    
    // ... (El resto de compileLogic sigue igual)
    const scriptCode = serverLogic + `\n;({
        onUpdate: (typeof onUpdate!=='undefined'?onUpdate:null), 
        onInput: (typeof onInput!=='undefined'?onInput:null),
        onBot: (typeof onBot!=='undefined'?onBot:null),
        botConfig: (typeof botConfig!=='undefined'?botConfig:{count:0, prefix: 'Mob'})
    })`;
    
    try {
        const userLogic = new vm.Script(scriptCode).runInNewContext(sandbox);
        return { userLogic, state: sandbox.state };
    } catch(e) {
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
app.post('/api/ai/generate', async (req, res) => {
    // Parámetros opcionales del cuerpo: prompt, model
    const { prompt, model = 'gemini-2.5-flash' } = req.body; 

    if (!prompt) {
        return res.status(400).send({ error: "Missing prompt." });
    }

    try {
        // Llamada real a la API de Gemini
        const response = await ai.models.generateContent({
            model: model,
            contents: prompt,
        });

        const textResponse = response.text; // Extrayendo solo el texto

        console.log(`[AI GENERATE] Prompt: "${prompt.substring(0, 30)}..." -> Success.`);
        res.send({ success: true, response: textResponse });

    } catch (e) {
        console.error(`[AI ERROR] Error al generar contenido con Gemini:`, e.message);
        res.status(500).send({ error: "AI generation failed: " + e.message });
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
app.post('/api/game-state/save', async (req, res) => {
    const { roomId, gameStateData } = req.body;
    
    if (!roomId || !gameStateData) {
        return res.status(400).send({ error: "Missing roomId or gameStateData." });
    }

    try {
        // Asegúrate de que gameStateData es una cadena (string) para el JSONB/Text de Supabase
        const stateString = typeof gameStateData === 'object' ? JSON.stringify(gameStateData) : gameStateData;

        const { error: dbError } = await supabase.from('game_rooms').update({
            game_state_data: stateString
        }).eq('id', roomId);

        if (dbError) {
            console.error(`[SAVE ERROR ${roomId}] Error al guardar estado en Supabase:`, dbError);
            return res.status(500).send({ error: "Database save failed: " + dbError.message });
        }
        
        console.log(`[STATE SAVE ${roomId}] Estado guardado correctamente.`);
        res.send({ success: true, message: "Game state saved successfully." });

    } catch (e) {
        console.error(`[STATE SAVE ERROR ${roomId}]`, e.message);
        res.status(500).send({ error: "Server error during state save: " + e.message });
    }
});

/**
 * GET /api/game-state/load/{roomId}
 * Obtiene el estado del juego (gameStateData) para un roomId específico.
 * Utilizado por la lógica del servidor para cargar datos en tiempo real (si es necesario) o por la API de Spring Boot.
 */
app.get('/api/game-state/load/:roomId', async (req, res) => {
    const roomId = req.params.roomId;
    
    try {
        const { data: roomData, error: dbError } = await supabase.from('game_rooms')
            .select('game_state_data')
            .eq('id', roomId)
            .single();

        if (dbError || !roomData) {
            console.error(`[LOAD ERROR ${roomId}] Error al cargar estado:`, dbError ? dbError.message : 'Room not found.');
            return res.status(404).send({ error: "Game state not found or database error." });
        }
        
        // Devolver el dato tal cual se almacena (string JSON o null)
        const gameStateData = roomData.game_state_data;
        
        console.log(`[STATE LOAD ${roomId}] Estado cargado.`);
        res.send({ 
            success: true, 
            gameStateData: gameStateData ? JSON.parse(gameStateData) : null 
        });

    } catch (e) {
        console.error(`[STATE LOAD ERROR ${roomId}]`, e.message);
        res.status(500).send({ error: "Server error during state load: " + e.message });
    }
});

// ==============================================================
// ENDPOINT API HTTP PARA RECIBIR PUBLICACIÓN DEL EDITOR (SPRING BOOT)
// ==============================================================

app.post('/api/publish-room', async (req, res) => {
// ... (El código de publish-room, SOCKET.IO LOGIC, y todo lo demás permanece sin cambios)
// ... (Tu lógica de publish-room)
    const { roomId, serverLogic, clientStructureHtml, clientRenderScript, clientInputScript } = req.body;
    
    if (!roomId) {
        return res.status(400).send({ error: "Missing roomId." });
    }

    try {
        // 2. GUARDAR DATOS EN SUPABASE (Node.js hace el POST)
        // ... (Tu lógica de guardado en Supabase permanece igual)
        const { error: dbError } = await supabase.from('game_rooms').update({
            server_logic: serverLogic,
            client_structure_html: clientStructureHtml,
            client_render_script: clientRenderScript,
            client_input_script: clientInputScript
        }).eq('id', roomId);

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
            io.to(roomId).emit("design_update", { // Renombramos el evento si usaste 'system_update' antes
                structure: clientStructureHtml,
                renderScript: clientRenderScript,
                // Nota: Los scripts se envían sin las etiquetas <script> para facilitar la inyección
                inputScript: clientInputScript 
            });
        }
        
        console.log(`[LIVE UPDATE ${roomId}] Lógica Server recompilada y DB actualizada.`);
        res.send({ success: true, message: "Published and live update initiated." });

    } catch (e) {
        console.error(`[PUBLISH ERROR ${roomId}]`, e.message);
        res.status(500).send({ error: "Server error during live update: " + e.message });
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
        if (!rooms[roomId]) {
            console.log(`[*] Iniciando sala ${roomId}...`);
            
            const { data: roomData, error: roomError } = await supabase.from('game_rooms').select('server_logic, owner_id, game_state_data').eq('id', roomId).single();
            if (roomError || !roomData) return;

            // Cargar estado persistente o iniciar vacío
            const initialState = roomData.game_state_data ? JSON.parse(roomData.game_state_data) : { tick: 0, jugadores: [], mapa: {} };
            
            // *** CAMBIO CLAVE AQUÍ: Pasar el roomId a compileLogic ***
            const { userLogic, state: newState } = compileLogic(roomData.server_logic, initialState, roomId);
            
            rooms[roomId] = {
                state: newState,
                logic: userLogic,
                ownerId: roomData.owner_id,
                players: new Set(),
                bots: [] 
            };

            // SPAWN DE BOTS (Integrado)
            if (userLogic.botConfig && userLogic.botConfig.count > 0) {
                for(let i=0; i < userLogic.botConfig.count; i++) {
                    const botId = "bot_" + Math.random().toString(36).substr(2, 5);
                    rooms[roomId].state.jugadores.push({
                        id: botId,
                        nombre: (userLogic.botConfig.prefix || "Mob") + "_" + i,
                        pos: { x: Math.random()*100, z: Math.random()*100 }
                    });
                    rooms[roomId].bots.push({ myId: botId, init: false, timer: 0 });
                }
            }

            // GAME LOOP (Con try/catch para evitar crash total)
            rooms[roomId].interval = setInterval(() => {
                const r = rooms[roomId];
                
                try {
                    if (r.logic.onUpdate) r.logic.onUpdate(r.state, 0.033);

                    if (r.logic.onBot) {
                        r.bots.forEach(botMemory => {
                            const action = r.logic.onBot(r.state, botMemory);
                            if (action && r.logic.onInput) {
                                action.id = botMemory.myId; 
                                r.logic.onInput(action, r.state);
                            }
                        });
                    }

                    io.to(roomId).emit("state_update", r.state);
                    
                } catch(e) { 
                    console.error(`[CRASH ROOM ${roomId}] Lógica fallida:`, e.message);
                    io.to(roomId).emit("system_error", "El código de la sala falló en runtime.");
                    stopRoom(roomId); 
                }

            }, 33); 
        }

        // 2. AÑADIR JUGADOR REAL
        if (rooms[roomId]) {
            rooms[roomId].players.add(socket.id);
            if(!rooms[roomId].state.jugadores.find(p=>p.id===socket.id)) {
                const playerId = socket.userId || socket.id; 
                rooms[roomId].state.jugadores.push({ id: playerId, nombre: socket.userId ? 'Player_'+socket.userId.substr(0,4) : 'Anon_'+socket.id.substr(0,4), pos: {x:50, z:50} });
            }
        }
    });

    // 3. RECIBIR INPUTS DE JUGADORES REALES
    socket.on("sim_input", (payload) => {
        const r = rooms[socket.roomId];
        if (r && r.logic.onInput) {
            payload.id = socket.userId || socket.id; 
            try { r.logic.onInput(payload, r.state); } catch(e){ console.error(`[Input Error]`, e.message); }
        }
    });

    // 4. DESCONEXIÓN
    socket.on("disconnect", async () => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            rooms[roomId].players.delete(socket.id);
            rooms[roomId].state.jugadores = rooms[roomId].state.jugadores.filter(p => p.id !== (socket.userId || socket.id));
            
            if (rooms[roomId].players.size === 0) {
                // TODO: Llamar a Spring Boot API para guardar estado final si es necesario
                stopRoom(roomId);
            }
        }
    });
});