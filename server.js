const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let salas = {}; 

function criarTabuleiroVazio() {
    return Array(8).fill(0).map(() => Array(8).fill(0));
}

io.on('connection', (socket) => {
    // Lista de salas públicas (sem expor a senha real para o client)
    socket.emit('lista_salas', obterSalasPublicas());

    // Criar Sala com Senha opcional
    socket.on('criar_sala', ({ nomeDono, senha }) => {
        const salaId = 'SALA_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        
        salas[salaId] = {
            id: salaId,
            donoId: socket.id,
            senha: senha || null, // Se vazio, é pública
            status: 'lobby',
            jogadores: [
                { id: socket.id, nome: nomeDono || 'Jogador 1', tabuleiro: criarTabuleiroVazio(), pronto: false, isBot: false, vivo: true, estatisticas: { tirosDados: 0, tirosTomados: 0, abates: 0 } }
            ],
            turnoAtual: 0,
            tirosRestantesNoTurno: 2 // Cada jogador começa com 2 tiros por turno
        };

        socket.join(salaId);
        socket.emit('sala_criada', salaId);
        io.emit('lista_salas', obterSalasPublicas());
        io.to(salaId).emit('atualizar_sala', filtrarDadosSala(salas[salaId]));
    });

    // Entrar na Sala (Validando Senha)
    socket.on('entrar_sala', ({ salaId, nomeJogador, senhaInserida }) => {
        const sala = salas[salaId];
        if (!sala) return socket.emit('erro', 'Sala não encontrada.');
        if (sala.status !== 'lobby') return socket.emit('erro', 'Jogo já iniciado.');
        if (sala.jogadores.length >= 4) return socket.emit('erro', 'Sala cheia.');
        if (sala.senha && sala.senha !== senhaInserida) return socket.emit('erro', 'Senha incorreta!');

        sala.jogadores.push({
            id: socket.id,
            nome: nomeJogador || `Jogador ${sala.jogadores.length + 1}`,
            tabuleiro: criarTabuleiroVazio(),
            pronto: false,
            isBot: false,
            vivo: true,
            estatisticas: { tirosDados: 0, tirosTomados: 0, abates: 0 }
        });

        socket.join(salaId);
        io.to(salaId).emit('atualizar_sala', filtrarDadosSala(sala));
        io.emit('lista_salas', obterSalasPublicas());
    });

    // Adicionar/Remover Bot de dentro do Lobby
    socket.on('alternar_bot', ({ salaId, acao }) => {
        const sala = salas[salaId];
        if (!sala || sala.donoId !== socket.id || sala.status !== 'lobby') return;

        if (acao === 'adicionar' && sala.jogadores.length < 4) {
            sala.jogadores.push({
                id: `bot_${Math.random()}`,
                nome: `Bot ${sala.jogadores.length + 1}`,
                tabuleiro: gerarTabuleiroBot(),
                pronto: true,
                isBot: true,
                vivo: true,
                estatisticas: { tirosDados: 0, tirosTomados: 0, abates: 0 }
            });
        } else if (acao === 'remover') {
            // Remove o último bot da lista
            const idxBot = findLastIndex(sala.jogadores, j => j.isBot);
            if (idxBot !== -1) sala.jogadores.splice(idxBot, 1);
        }

        io.to(salaId).emit('atualizar_sala', filtrarDadosSala(sala));
        io.emit('lista_salas', obterSalasPublicas());
    });

    // Kickar Jogador
    socket.on('kick_jogador', ({ salaId, jogadorId }) => {
        const sala = salas[salaId];
        if (!sala || sala.donoId !== socket.id) return;

        sala.jogadores = sala.jogadores.filter(j => j.id !== jogadorId);
        const socketKickado = io.sockets.sockets.get(jogadorId);
        if (socketKickado) {
            socketKickado.leave(salaId);
            socketKickado.emit('kickado');
        }

        io.to(salaId).emit('atualizar_sala', filtrarDadosSala(sala));
        io.emit('lista_salas', obterSalasPublicas());
    });

    socket.on('iniciar_posicionamento', ({ salaId }) => {
        const sala = salas[salaId];
        if (!sala || sala.donoId !== socket.id) return;

        sala.status = 'posicionando';
        io.to(salaId).emit('fase_posicionamento', filtrarDadosSala(sala));
    });

    socket.on('tabuleiro_pronto', ({ salaId, tabuleiro }) => {
        const sala = salas[salaId];
        if (!sala) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (jogador) {
            jogador.tabuleiro = tabuleiro;
            jogador.pronto = true;
        }

        const todosProntos = sala.jogadores.every(j => j.pronto);
        if (todosProntos && sala.jogadores.length >= 2) {
            // Garante que os bots tenham barcos gerados
            sala.jogadores.forEach(j => {
                if (j.isBot) j.tabuleiro = gerarTabuleiroBot();
            });

            sala.status = 'jogando';
            sala.turnoAtual = encontrarProximoJogadorVivo(sala, 0);
            sala.tirosRestantesNoTurno = 2; 
            io.to(salaId).emit('jogo_iniciado', filtrarDadosSala(sala));
        } else {
            io.to(salaId).emit('atualizar_sala', filtrarDadosSala(sala));
        }
    });

    // Lógica Avançada de Disparo (2 tiros + Detecção de Morte/Vitória)
    socket.on('dar_tiro', ({ salaId, alvoIndex, linha, ...data }) => {
        const coluna = data.coluna;
        const sala = salas[salaId];
        if (!sala || sala.status !== 'jogando') return;

        const atirador = sala.jogadores[sala.turnoAtual];
        if (atirador.id !== socket.id || !atirador.vivo) return;

        const vitima = sala.jogadores[alvoIndex];
        if (!vitima || !vitima.vivo || vitima.tabuleiro[linha][coluna] > 1) return;

        // Executa o tiro
        atirador.estatisticas.tirosDados++;
        vitima.estatisticas.tirosTomados++;

        if (vitima.tabuleiro[linha][coluna] === 1) {
            vitima.tabuleiro[linha][coluna] = 3; // Fogo
            // Verifica se a vítima perdeu todos os navios (morreu)
            if (!verificarSeTemNavioVivo(vitima.tabuleiro)) {
                vitima.vivo = false;
                atirador.estatisticas.abates++;
                io.to(salaId).emit('notificacao', `${vitima.nome} foi completamente afundado por ${atirador.nome}!`);
            }
        } else {
            vitima.tabuleiro[linha][coluna] = 2; // Água
        }

        sala.tirosRestantesNoTurno--;

        // Verifica se há um vencedor antes de prosseguir
        if (verificarFimDeJogo(salaId)) return;

        // Se acabaram os tiros ou o jogador atual morreu na rodada (improvável, mas por segurança), passa o turno
        if (sala.tirosRestantesNoTurno <= 0) {
            passarTurnoCompleto(salaId);
        } else {
            io.to(salaId).emit('atualizar_jogo', filtrarDadosSala(sala));
        }
    });

    socket.on('disconnect', () => {
        for (const salaId in salas) {
            const sala = salas[salaId];
            sala.jogadores = sala.jogadores.filter(j => j.id !== socket.id);
            if (sala.jogadores.filter(j => !j.isBot).length === 0) {
                delete salas[salaId];
            } else if (sala.status === 'jogando') {
                verificarFimDeJogo(salaId);
            }
        }
        io.emit('lista_salas', obterSalasPublicas());
    });
});

function passarTurnoCompleto(salaId) {
    const sala = salas[salaId];
    if (!sala || sala.status !== 'jogando') return;

    let proximoIdx = (sala.turnoAtual + 1) % sala.jogadores.length;
    sala.turnoAtual = encontrarProximoJogadorVivo(sala, proximoIdx);
    sala.tirosRestantesNoTurno = 2; // Reseta os 2 tiros para o próximo

    io.to(salaId).emit('atualizar_jogo', filtrarDadosSala(sala));

    // Turno Inteligente do BOT (Executa 2 tiros seguidos)
    const atual = sala.jogadores[sala.turnoAtual];
    if (atual && atual.isBot && atual.vivo) {
        executarTurnoBotDuplo(salaId, atual);
    }
}

function executarTurnoBotDuplo(salaId, bot) {
    const sala = salas[salaId];
    if (!sala || sala.status !== 'jogando' || !bot.vivo) return;

    setTimeout(() => {
        // Encontra uma vítima viva válida
        let alvosVivos = sala.jogadores.filter((j, i) => j.vivo && i !== sala.turnoAtual);
        if (alvosVivos.length === 0) return;
        let vitima = alvosVivos[Math.floor(Math.random() * alvosVivos.length)];
        let alvoIndex = sala.jogadores.indexOf(vitima);

        let l, c;
        do {
            l = Math.floor(Math.random() * 8);
            c = Math.floor(Math.random() * 8);
        } while (vitima.tabuleiro[l][c] > 1);

        bot.estatisticas.tirosDados++;
        vitima.estatisticas.tirosTomados++;

        if (vitima.tabuleiro[l][c] === 1) {
            vitima.tabuleiro[l][c] = 3;
            if (!verificarSeTemNavioVivo(vitima.tabuleiro)) {
                vitima.vivo = false;
                bot.estatisticas.abates++;
                io.to(salaId).emit('notificacao', `${vitima.nome} foi afundado pelo ${bot.nome}!`);
            }
        } else {
            vitima.tabuleiro[l][c] = 2;
        }

        sala.tirosRestantesNoTurno--;

        if (verificarFimDeJogo(salaId)) return;

        if (sala.tirosRestantesNoTurno > 0) {
            executarTurnoBotDuplo(salaId, bot); // Dá o segundo tiro
        } else {
            passarTurnoCompleto(salaId);
        }
    }, 1000);
}

function verificarSeTemNavioVivo(tab) {
    return tab.some(row => row.includes(1));
}

function encontrarProximoJogadorVivo(sala, idxInicial) {
    let tentativa = idxInicial;
    for (let i = 0; i < sala.jogadores.length; i++) {
        if (sala.jogadores[tentativa].vivo) return tentativa;
        tentativa = (tentativa + 1) % sala.jogadores.length;
    }
    return idxInicial;
}

function verificarFimDeJogo(salaId) {
    const sala = salas[salaId];
    const vivos = sala.jogadores.filter(j => j.vivo);

    if (vivos.length <= 1) {
        sala.status = 'finalizado';
        const vencedor = vivos[0] || null;
        
        // Constrói o Ranking
        const ranking = [...sala.jogadores].sort((a, b) => b.estatisticas.abates - a.estatisticas.abates);
        
        io.to(salaId).emit('fim_de_jogo', { vencedor: vencedor ? vencedor.nome : 'Ninguém', ranking });
        delete salas[salaId]; // Limpa a sala do servidor
        io.emit('lista_salas', obterSalasPublicas());
        return true;
    }
    return false;
}

function obterSalasPublicas() {
    return Object.values(salas)
        .filter(s => s.status === 'lobby')
        .map(s => ({ id: s.id, qtd: s.jogadores.length, privado: s.senha !== null }));
}

function filtrarDadosSala(sala) {
    // Retorna a estrutura da sala ocultando a senha real do backend
    return { ...sala, senha: !!sala.senha };
}

function findLastIndex(array, predicate) {
    for (let i = array.length - 1; i >= 0; i--) {
        if (predicate(array[i])) return i;
    }
    return -1;
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
                for(let i=0; i<tamanho; i++) tab[r + (horiz ? 0 : i)][c + (horiz ? i : 0)] = 1;
                alocado = true;
            }
        }
    });
    return tab;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));