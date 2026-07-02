const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Gerenciamento de múltiplas salas
let salas = {}; 

function criarTabuleiroVazio() {
    return Array(8).fill(0).map(() => Array(8).fill(0));
}

io.on('connection', (socket) => {
    console.log(`Conectado: ${socket.id}`);

    // Envia a lista de salas públicas para quem acabou de conectar
    socket.emit('lista_salas', obterSalasPublicas());

    // Criar Nova Sala
    socket.on('criar_sala', ({ nomeDono, usarBots }) => {
        const salaId = 'SALA_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        
        salas[salaId] = {
            id: salaId,
            donoId: socket.id,
            usarBots: usarBots,
            status: 'lobby', // lobby, posicionando, jogando
            jogadores: [
                { id: socket.id, nome: nomeDono || 'Jogador 1', tabuleiro: criarTabuleiroVazio(), pronto: false, isBot: false }
            ],
            turnoAtual: 0
        };

        socket.join(salaId);
        socket.emit('sala_criada', salaId);
        io.emit('lista_salas', obterSalasPublicas());
        io.to(salaId).emit('atualizar_sala', salas[salaId]);
    });

    // Entrar em uma Sala Existente
    socket.on('entrar_sala', ({ salaId, nomeJogador }) => {
        const sala = salas[salaId];
        if (!sala) return socket.emit('erro', 'Sala não encontrada.');
        if (sala.status !== 'lobby') return socket.emit('erro', 'Jogo já iniciado.');
        if (sala.jogadores.length >= 4) return socket.emit('erro', 'Sala cheia.');

        sala.jogadores.push({
            id: socket.id,
            nome: nomeJogador || `Jogador ${sala.jogadores.length + 1}`,
            tabuleiro: criarTabuleiroVazio(),
            pronto: false,
            isBot: false
        });

        socket.join(salaId);
        io.to(salaId).emit('atualizar_sala', sala);
        io.emit('lista_salas', obterSalasPublicas());
    });

    // Kickar Jogador (Apenas o Dono)
    socket.on('kick_jogador', ({ salaId, jogadorId }) => {
        const sala = salas[salaId];
        if (!sala || sala.donoId !== socket.id) return;

        sala.jogadores = sala.jogadores.filter(j => j.id !== jogadorId);
        
        const socketKickado = io.sockets.sockets.get(jogadorId);
        if (socketKickado) {
            socketKickado.leave(salaId);
            socketKickado.emit('kickado');
        }

        io.to(salaId).emit('atualizar_sala', sala);
        io.emit('lista_salas', obterSalasPublicas());
    });

    // Começar Fase de Posicionamento
    socket.on('iniciar_posicionamento', ({ salaId }) => {
        const sala = salas[salaId];
        if (!sala || sala.donoId !== socket.id) return;

        // Se optou por bots, preenche as vagas restantes imediatamente
        if (sala.usarBots) {
            while (sala.jogadores.length < 4) {
                sala.jogadores.push({
                    id: `bot_${Math.random()}`,
                    nome: `Bot ${sala.jogadores.length + 1}`,
                    tabuleiro: criarTabuleiroVazio(),
                    pronto: true,
                    isBot: true
                });
            }
        }

        sala.status = 'posicionando';
        io.to(salaId).emit('fase_posicionamento', sala);
        io.emit('lista_salas', obterSalasPublicas());
    });

    // Salvar o Tabuleiro pronto enviado pelo jogador
    socket.on('tabuleiro_pronto', ({ salaId, tabuleiro }) => {
        const sala = salas[salaId];
        if (!sala) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (jogador) {
            jogador.tabuleiro = tabuleiro;
            jogador.pronto = true;
        }

        // Se todos os humanos estiverem prontos, começa a partida
        const todosProntos = sala.jogadores.every(j => j.pronto);
        if (todosProntos && sala.jogadores.length >= 2) {
            
            // Se não usou a opção de bots e o jogo iniciou com menos de 4, preenche com bots para manter a mecânica de 4 quadrantes ativa se necessário
            while (sala.jogadores.length < 4) {
                sala.jogadores.push({
                    id: `bot_${Math.random()}`,
                    nome: `Bot ${sala.jogadores.length + 1}`,
                    tabuleiro: gerarTabuleiroBot(),
                    pronto: true,
                    isBot: true
                });
            }

            // Garante que os bots iniciais também tenham barcos posicionados
            sala.jogadores.forEach(j => {
                if (j.isBot) j.tabuleiro = gerarTabuleiroBot();
            });

            sala.status = 'jogando';
            sala.turnoAtual = 0;
            io.to(salaId).emit('jogo_iniciado', sala);
        } else {
            io.to(salaId).emit('atualizar_sala', sala);
        }
    });

    // Lógica do Tiro (Multiplayer)
    socket.on('dar_tiro', ({ salaId, alvoIndex, linha, coluna }) => {
        const sala = salas[salaId];
        if (!sala || sala.status !== 'jogando') return;

        if (sala.jogadores[sala.turnoAtual].id !== socket.id) return;

        const vitima = sala.jogadores[alvoIndex];
        if (!vitima || vitima.tabuleiro[linha][coluna] > 1) return; // Já atirou aqui

        if (vitima.tabuleiro[linha][coluna] === 1) {
            vitima.tabuleiro[linha][coluna] = 3; // Acerto
        } else {
            vitima.tabuleiro[linha][coluna] = 2; // Água
        }

        passarTurno(salaId);
    });

    socket.on('disconnect', () => {
        for (const salaId in salas) {
            const sala = salas[salaId];
            sala.jogadores = sala.jogadores.filter(j => j.id !== socket.id);

            if (sala.jogadores.filter(j => !j.isBot).length === 0) {
                delete salas[salaId]; // Apaga sala vazia
            } else if (sala.donoId === socket.id) {
                const novoDono = sala.jogadores.find(j => !j.isBot);
                if (novoDono) sala.donoId = novoDono.id; // Passa a liderança
            }
            io.to(salaId).emit('atualizar_sala', sala);
        }
        io.emit('lista_salas', obterSalasPublicas());
    });
});

function passarTurno(salaId) {
    const sala = salas[salaId];
    if (!sala) return;

    sala.turnoAtual = (sala.turnoAtual + 1) % sala.jogadores.length;
    io.to(salaId).emit('atualizar_jogo', sala);

    // Se o próximo for bot, ele joga automático
    const proximo = sala.jogadores[sala.turnoAtual];
    if (proximo && proximo.isBot) {
        setTimeout(() => {
            let alvoIndex;
            do {
                alvoIndex = Math.floor(Math.random() * sala.jogadores.length);
            } while (alvoIndex === sala.turnoAtual);

            const vitima = sala.jogadores[alvoIndex];
            let l, c;
            do {
                l = Math.floor(Math.random() * 8);
                c = Math.floor(Math.random() * 8);
            } while (vitima.tabuleiro[l][c] > 1);

            if (vitima.tabuleiro[l][c] === 1) vitima.tabuleiro[l][c] = 3;
            else vitima.tabuleiro[l][c] = 2;

            passarTurno(salaId);
        }, 1200);
    }
}

function obterSalasPublicas() {
    return Object.values(salas)
        .filter(s => s.status === 'lobby')
        .map(s => ({ id: s.id, qtd: s.jogadores.length, bots: s.usarBots }));
}

function gerarTabuleiroBot() {
    let tab = criarTabuleiroVazio();
    const barcos = [3, 2, 2];
    barcos.forEach(tamanho => {
        let alocado = false;
        while (!alocado) {
            let horiz = Math.random() > 0.5;
            let r = Math.floor(Math.random() * (horiz ? 8 : (8 - tamanho)));
            let c = Math.floor(Math.random() * (horiz ? (8 - tamanho) : 8));
            
            let livre = true;
            for(let i=0; i<tamanho; i++) {
                if (tab[r + (horiz ? 0 : i)][c + (horiz ? i : 0)] === 1) livre = false;
            }
            if (livre) {
                for(let i=0; i<tamanho; i++) {
                    tab[r + (horiz ? 0 : i)][c + (horiz ? i : 0)] = 1;
                }
                alocado = true;
            }
        }
    });
    return tab;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));