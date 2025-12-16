const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const vm = require('vm');

// --- CONFIGURACIÓN ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'TU_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'TU_SUPABASE_KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- CLASE GAMEROOM (LÓGICA) ---
class GameRoom {
    constructor(roomId, ioInstance) {
        this.id = roomId;
        this.io = ioInstance;
        // Estado inicial limpio
        this.state = { 
            players: {}, 
            tick: 0 
        };
        this.inputsQueue = []; 
        
        // Memoria de teclas presionadas por cada jugador (Para movimiento fluido)
        this.playerInputs = {}; 

        console.log(`[SALA] Iniciada: ${this.id}`);
        this.restoreFromDb().then(() => this.startGameLoop());
    }

    async restoreFromDb() {
        const { data } = await supabase.from('room_storage').select('public_state').eq('room_id', this.id).single();
        if (data?.public_state) {
            this.state = { ...this.state, ...data.public_state };
            // Limpiamos jugadores viejos de la DB al reiniciar para evitar fantasmas
            this.state.players = {}; 
        }
    }

    addPlayer(socketId) {
        // Inicializamos input vacío para este jugador
        this.playerInputs[socketId] = { keys: [] };
        // El jugador real se crea en la lógica del usuario (VM), aquí solo preparamos
    }

    removePlayer(socketId) {
        if (this.state.players && this.state.players[socketId]) {
            delete this.state.players[socketId];
        }
        delete this.playerInputs[socketId];
    }

    pushInput(socketId, payload) {
        // Actualizamos el estado de teclas actual de este jugador
        if (payload.type === 'MOVE') {
            this.playerInputs[socketId] = payload; // Guardamos { keys: ['w', 'a'] }
        }
        
        // También pasamos el evento crudo a la lógica por si quiere disparar acciones únicas (saltar, disparar)
        this.inputsQueue.push({ senderId: socketId, ...payload });
    }

    startGameLoop() {
        // Cargar código de la sala
        this.logicCode = "";
        supabase.from('game_rooms').select('server_logic').eq('id', this.id).single()
            .then(({ data }) => { if(data) this.logicCode = data.server_logic; });

        setInterval(() => {
            if (Object.keys(this.state.players).length === 0 && this.inputsQueue.length === 0) return;

            try {
                // SANDBOX: Le pasamos 'activeInputs' para movimiento fluido
                const sandbox = {
                    state: this.state,
                    inputs: this.inputsQueue,      // Eventos únicos (disparos, clicks)
                    activeInputs: this.playerInputs, // Estado mantenido (teclas presionadas)
                    Math: Math,
                    console: { log: () => {} }
                };

                vm.createContext(sandbox);
                // Si hay lógica personalizada, usarla. Si no, usar default seguro.
                const codeToRun = this.logicCode || `
                    // Lógica Default de Emergencia
                    Object.keys(activeInputs).forEach(id => {
                        if(!state.players[id]) state.players[id] = { x: 100, y: 100, color: 'cyan' };
                        const keys = activeInputs[id].keys || [];
                        const p = state.players[id];
                        if(keys.includes('ArrowRight')) p.x += 5;
                        if(keys.includes('ArrowLeft')) p.x -= 5;
                        if(keys.includes('ArrowUp')) p.y -= 5;
                        if(keys.includes('ArrowDown')) p.y += 5;
                    });
                `;
                
                vm.runInContext(codeToRun, sandbox);

                this.state = sandbox.state;
                this.inputsQueue = []; // Limpiar cola de eventos únicos
                this.state.tick++;

                this.io.to(this.id).emit('game_tick', this.state);

            } catch (e) {
                console.error(`Error en sala ${this.id}:`, e.message);
            }
        }, 1000 / 60); // 60 FPS
    }

    updateLogic(newCode) {
        this.logicCode = newCode;
    }
}

// --- GESTOR DE CONEXIONES ---
const activeRooms = {}; 

io.on('connection', (socket) => {
    // console.log(`[+] ${socket.id}`);
    
    // Mapeo rápido para saber en qué sala está el socket al desconectarse
    socket.roomId = null; 

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        socket.roomId = roomId;

        if (!activeRooms[roomId]) {
            activeRooms[roomId] = new GameRoom(roomId, io);
        }
        activeRooms[roomId].addPlayer(socket.id);
    });

    socket.on('input_data', ({ roomId, payload }) => {
        if (activeRooms[roomId]) {
            activeRooms[roomId].pushInput(socket.id, payload);
        }
    });

    socket.on('update_code', ({ roomId, logicCode }) => {
        if (activeRooms[roomId]) {
            activeRooms[roomId].updateLogic(logicCode);
            io.to(roomId).emit('notification', 'Lógica Actualizada');
        }
    });

    socket.on('persist_save', async (data) => { /* ... lógica de guardado anterior ... */ });

    socket.on('disconnect', () => {
        const rId = socket.roomId;
        if (rId && activeRooms[rId]) {
            activeRooms[rId].removePlayer(socket.id);
            // console.log(`[-] ${socket.id} salió de ${rId}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Engine Server v2 running on ${PORT}`));