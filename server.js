const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Estado do jogo simplificado (Mesa de 4 posições)
let sala = {
    jogadores: [], // max 4
    turnoAtual: 0,
    status: 'aguardando' // aguardando, jogando
};

// Cria os tabuleiros (0 = água, 1 = navio, 2 = erro/água atingida, 3 = acerto)
function criarTabuleiro() {
    let tab = Array(5).fill(0).map(() => Array(5).fill(0));
    // Coloca 2 navios aleatórios para testes rápidos (matriz 5x5)
    for(let i=0; i<2; i++) {
        let r = Math.floor(Math.random() * 5);
        let c = Math.floor(Math.random() * 5);
        tab[r][c] = 1;
    }
    return tab;
}

io.on('connection', (socket) => {
    console.log(`Usuário conectado: ${socket.id}`);

    // Se a sala não estiver cheia, adiciona o jogador
    if (sala.jogadores.length < 4 && sala.status === 'aguardando') {
        sala.jogadores.push({
            id: socket.id,
            nome: `Jogador ${sala.jogadores.length + 1}`,
            tabuleiro: criarTabuleiro(),
            isBot: false
        });
        io.emit('atualizar_sala', sala);
    }

    // Evento para iniciar a partida (preenche o resto com BOTS se faltar gente)
    socket.on('iniciar_jogo', () => {
        while (sala.jogadores.length < 4) {
            sala.jogadores.push({
                id: `bot_${Math.random()}`,
                nome: `Bot ${sala.jogadores.length + 1}`,
                tabuleiro: criarTabuleiro(),
                isBot: true
            });
        }
        sala.status = 'jogando';
        sala.turnoAtual = 0;
        io.emit('jogo_iniciado', sala);
    });

    // Evento do Tiro
    socket.on('dar_tiro', ({ alvoIndex, linha, coluna }) => {
        if (sala.status !== 'jogando') return;
        
        // Verifica se quem atirou é o jogador do turno atual
        const jogadorQueAtirou = sala.jogadores[sala.turnoAtual];
        if (jogadorQueAtirou.id !== socket.id) return;

        const vitima = sala.jogadores[alvoIndex];
        
        // Lógica do acerto
        if (vitima.tabuleiro[linha][coluna] === 1) {
            vitima.tabuleiro[linha][coluna] = 3; // Acertou navio
        } else if (vitima.tabuleiro[linha][coluna] === 0) {
            vitima.tabuleiro[linha][coluna] = 2; // Água
        }

        // Passa o turno para o próximo jogador
        sala.turnoAtual = (sala.turnoAtual + 1) % 4;

        io.emit('atualizar_jogo', sala);

        // Se o próximo turno for um BOT, faz ele jogar automaticamente
        executarTurnoBot();
    });

    socket.on('disconnect', () => {
        sala.jogadores = sala.jogadores.filter(j => j.id !== socket.id);
        if (sala.jogadores.length === 0) {
            sala.status = 'aguardando';
        }
        io.emit('atualizar_sala', sala);
    });
});

function executarTurnoBot() {
    if (sala.status !== 'jogando') return;
    let atual = sala.jogadores[sala.turnoAtual];
    
    if (atual && atual.isBot) {
        setTimeout(() => {
            // Bot escolhe um alvo aleatório que não seja ele mesmo
            let alvoIndex;
            do {
                alvoIndex = Math.floor(Math.random() * 4);
            } while (alvoIndex === sala.turnoAtual);

            let l = Math.floor(Math.random() * 5);
            let c = Math.floor(Math.random() * 5);

            let vitima = sala.jogadores[alvoIndex];
            if (vitima.tabuleiro[l][c] === 1) vitima.tabuleiro[l][c] = 3;
            else if (vitima.tabuleiro[l][c] === 0) vitima.tabuleiro[l][c] = 2;

            sala.turnoAtual = (sala.turnoAtual + 1) % 4;
            io.emit('atualizar_jogo', sala);

            // Se o próximo também for bot, roda de novo recursivamente
            executarTurnoBot();
        }, 1500); // Delay de 1.5s para parecer que o bot está pensando
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));