const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Configura tus variables de entorno en Render/Railway
const SUPABASE_URL = process.env.SUPABASE_URL || 'TU_URL_AQUI';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'TU_KEY_AQUI'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(cors());

// Health Check para servicios de nube
app.get('/', (req, res) => res.send('EngineIO Server Running'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MUNDOS_DB = { "sala_builder": { players: {}, config: {} } };

io.on('connection', (socket) => {
    console.log(`[CONEXIÓN] ${socket.id}`);

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        // Aquí iría tu lógica de instanciación de GameRoom real
        // Por ahora simulamos un echo para el builder
    });

    socket.on('input_data', ({ roomId, payload }) => {
        // En un server real, esto va a GameRoom.pushInput()
        // Para el builder, hacemos un echo inmediato simulando un tick
        io.to(roomId).emit('game_tick', {
            tick: Date.now(),
            players: { 
                [socket.id]: { 
                    x: Math.random() * 500, 
                    y: Math.random() * 500, 
                    color: payload.type === 'MOVE' ? 'lime' : 'magenta',
                    action: payload.type 
                } 
            }
        });
    });

    socket.on('persist_save', async ({ roomId, type, content, extra }) => {
        console.log(`[DB SAVE] ${roomId} (${type})`);
        
        const updatePayload = {};
        if (type === 'html') {
            updatePayload.client_html = content;
            if (extra && extra.creator) updatePayload.creator_name = extra.creator;
        }
        // ... otros tipos

        const { error } = await supabase
            .from('room_storage')
            .upsert({ room_id: roomId, ...updatePayload, updated_at: new Date() });

        if (error) console.error("Error DB:", error.message);
        else socket.emit('notification', 'Guardado OK');
    });

    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));