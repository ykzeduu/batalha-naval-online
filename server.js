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
    socket.emit('lista_salas', obterSalasPublicas());

    socket.on('criar_sala', ({ nomeDono, senha }) => {
        const salaId = 'SALA_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        
        salas[salaId] = {
            id: salaId,
            donoId: socket.id,
            senha: senha || null, 
            status: 'lobby',
            jogadores: [
                { id: socket.id, nome: nomeDono || 'Jogador 1', tabuleiro: criarTabuleiroVazio(), pronto: false, isBot: false, vivo: true, estatisticas: { tirosDados: 0, tirosTomados: 0, blocosAcertados: 0, abates: 0 }, bombas: 0, contadorParaBomba: 0 }
            ],
            turnoAtual: 0,
            tirosRestantesNoTurno: 2 
        };

        socket.join(salaId);
        socket.emit('sala_criada', salaId);
        io.emit('lista_salas', obterSalasPublicas());
        io.to(salaId).emit('atualizar_sala', filtrarDadosSala(salas[salaId]));
    });

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
            estatisticas: { tirosDados: 0, tirosTomados: 0, blocosAcertados: 0, abates: 0 },
            bombas: 0,
            contadorParaBomba: 0
        });

        socket.join(salaId);
        io.to(salaId).emit('atualizar_sala', filtrarDadosSala(sala));
        io.emit('lista_salas', obterSalasPublicas());
    });

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
                estatisticas: { tirosDados: 0, tirosTomados: 0, blocosAcertados: 0, abates: 0 },
                bombas: 0,
                contadorParaBomba: 0
            });
        } else if (acao === 'remover') {
            const idxBot = findLastIndex(sala.jogadores, j => j.isBot);
            if (idxBot !== -1) sala.jogadores.splice(idxBot, 1);
        }

        io.to(salaId).emit('atualizar_sala', filtrarDadosSala(sala));
        io.emit('lista_salas', obterSalasPublicas());
    });

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
            sala.status = 'jogando';
            sala.turnoAtual = encontrarProximoJogadorVivo(sala, 0);
            sala.tirosRestantesNoTurno = 2; 
            io.to(salaId).emit('jogo_iniciado', filtrarDadosSala(sala));
        } else {
            io.to(salaId).emit('atualizar_sala', filtrarDadosSala(sala));
        }
    });

    // LÓGICA DE TIRO ATUALIZADA (Tiro Normal ou Bomba em X)
    socket.on('dar_tiro', ({ salaId, alvoIndex, linha, coluna, usarBomba }) => {
        const sala = salas[salaId];
        if (!sala || sala.status !== 'jogando') return;

        const atirador = sala.jogadores[sala.turnoAtual];
        if (atirador.id !== socket.id || !atirador.vivo) return;

        const vitima = sala.jogadores[alvoIndex];
        if (!vitima || !vitima.vivo) return;

        if (usarBomba) {
            if (atirador.bombas <= 0) return socket.emit('erro', 'Você não possui bombas!');
            atirador.bombas--;

            // Definição do formato em X (Centro + 4 diagonais)
            const alvosBomba = [
                { r: linha, c: coluna },
                { r: linha - 1, c: coluna - 1 },
                { r: metaR = linha - 1, c: coluna + 1 },
                { r: linha + 1, c: coluna - 1 },
                { r: linha + 1, c: coluna + 1 }
            ];

            alvosBomba.forEach(alvo => {
                if (alvo.r >= 0 && alvo.r < 8 && alvo.c >= 0 && alvo.c < 8) {
                    let val = vitima.tabuleiro[alvo.r][alvo.c];
                    if (val < 2) { 
                        vitima.estatisticas.tirosTomados++;
                        if (val === 1) {
                            vitima.tabuleiro[alvo.r][alvo.c] = 3; // Fogo
                            atirador.estatisticas.blocosAcertados++;
                        } else {
                            vitima.tabuleiro[alvo.r][alvo.c] = 2; // Água
                        }
                    }
                }
            });

            atirador.estatisticas.tirosDados++;
            // Verifica morte pós-explosão
            if (vitima.vivo && !verificarSeTemNavioVivo(vitima.tabuleiro)) {
                vitima.vivo = false;
                atirador.estatisticas.abates++;
                io.to(salaId).emit('notificacao', `${vitima.nome} foi totalmente destruído pela bomba de ${atirador.nome}!`);
            }
            
            sala.tirosRestantesNoTurno = 0; // Usar bomba consome o resto do turno
        } else {
            // Tiro normal
            if (vitima.tabuleiro[linha][coluna] > 1) return;

            atirador.estatisticas.tirosDados++;
            vitima.estatisticas.tirosTomados++;

            // Incrementa contador de ganho de bomba
            atirador.contadorParaBomba++;
            if (atirador.contadorParaBomba >= 5) {
                atirador.bombas++;
                atirador.contadorParaBomba = 0;
                socket.emit('notificacao', '⚡ Você carregou uma Super Bomba em X!');
            }

            if (vitima.tabuleiro[linha][coluna] === 1) {
                vitima.tabuleiro[linha][coluna] = 3;
                atirador.estatisticas.blocosAcertados++;
                
                if (vitima.vivo && !verificarSeTemNavioVivo(vitima.tabuleiro)) {
                    vitima.vivo = false;
                    atirador.estatisticas.abates++;
                    io.to(salaId).emit('notificacao', `${vitima.nome} foi completamente afundado por ${atirador.nome}!`);
                }
            } else {
                vitima.tabuleiro[linha][coluna] = 2;
            }
            sala.tirosRestantesNoTurno--;
        }

        if (verificarFimDeJogo(salaId)) return;

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
    sala.tirosRestantesNoTurno = 2; 

    io.to(salaId).emit('atualizar_jogo', filtrarDadosSala(sala));

    const atual = sala.jogadores[sala.turnoAtual];
    if (atual && atual.isBot && atual.vivo) {
        executarTurnoBotDuplo(salaId, atual);
    }
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

function executarTurnoBotDuplo(salaId, bot) {
    const sala = salas[salaId];
    if (!sala || sala.status !== 'jogando' || !bot.vivo) return;

    setTimeout(() => {
        let alvosVivos = sala.jogadores.filter((j, i) => j.vivo && i !== sala.turnoAtual);
        if (alvosVivos.length === 0) return;
        
        let vitima = alvosVivos[Math.floor(Math.random() * alvosVivos.length)];
        let l, c;
        let tentativas = 0;
        do {
            l = Math.floor(Math.random() * 8);
            c = Math.floor(Math.random() * 8);
            tentativas++;
        } while (vitima.tabuleiro[l][c] > 1 && tentativas < 100);

        if (vitima.tabuleiro[l][c] > 1) return passarTurnoCompleto(salaId);

        bot.estatisticas.tirosDados++;
        vitima.estatisticas.tirosTomados++;

        if (vitima.tabuleiro[l][c] === 1) {
            vitima.tabuleiro[l][c] = 3;
            bot.estatisticas.blocosAcertados++;
            if (vitima.vivo && !verificarSeTemNavioVivo(vitima.tabuleiro)) {
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
            setTimeout(() => { executarTurnoBotDuplo(salaId, bot); }, 1000);
        } else {
            passarTurnoCompleto(salaId);
        }
    }, 1000); 
}

function verificarFimDeJogo(salaId) {
    const sala = salas[salaId];
    if (!sala) return false;
    const vivos = sala.jogadores.filter(j => j.vivo);

    if (vivos.length <= 1) {
        sala.status = 'revelando'; // Estado intermediário para mostrar o mapa
        const vencedor = vivos[0] || null;
        const ranking = [...sala.jogadores].sort((a, b) => b.estatisticas.blocosAcertados - a.estatisticas.blocosAcertados);
        
        // Emite evento de revelação imediata de 5 segundos
        io.to(salaId).emit('revelar_posicoes_finais', filtrarDadosSala(sala));

        setTimeout(() => {
            io.to(salaId).emit('fim_de_jogo', { vencedor: vencedor ? vencedor.nome : 'Ninguém', ranking });
            delete salas[salaId]; 
        }, 5000);

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