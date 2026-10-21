<!DOCTYPE html>
<html lang="pt" translate="no" class="notranslate">
<head>
<meta charset="UTF-8">
<meta name="google" content="notranslate">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CortePro v3</title>
<script>
const API_URL = 'https://cortepro-master.onrender.com';
let videoExtraido = '';

function mudarAba(aba) {
    document.getElementById('aba-web').style.display = (aba === 'web') ? 'flex' : 'none';
    document.getElementById('aba-divisor').style.display = (aba === 'divisor') ? 'flex' : 'none';
    document.getElementById('btn-aba-web').className = (aba === 'web') ? 'tab active' : 'tab';
    document.getElementById('btn-aba-div').className = (aba === 'divisor') ? 'tab active' : 'tab';
}

function mudarModo() {
    const modo = document.getElementById('modoCorte').value;
    document.getElementById('boxPartes').style.display = (modo === 'partes') ? 'block' : 'none';
    document.getElementById('boxTempo').style.display = (modo === 'tempo') ? 'block' : 'none';
}

async function extrairWeb() {
    const url = document.getElementById('urlInput').value.trim();
    const status = document.getElementById('statusWeb');
    const resBox = document.getElementById('resWeb');
    if (!url) { alert('Cole o link primeiro!'); return; }
    
    status.style.display = 'block';
    status.textContent = '⏳ A conectar ao servidor Render (aguarde)...';
    resBox.style.display = 'none';

    let seg = 0;
    const timer = setInterval(() => {
        seg++;
        status.textContent = '⏳ A extrair vídeo no Render (' + seg + 's)...';
    }, 1000);

    try {
        const r = await fetch(API_URL + '/api/extract?url=' + encodeURIComponent(url));
        clearInterval(timer);
        const d = await r.json();
        if (d.success && d.videoUrl) {
            videoExtraido = d.videoUrl;
            const proxy = API_URL + '/api/download-proxy?url=' + encodeURIComponent(d.videoUrl);
            status.textContent = '✅ Vídeo pronto!';
            document.getElementById('playerWeb').src = proxy;
            document.getElementById('linkDireto').href = proxy;
            resBox.style.display = 'flex';
        } else {
            status.textContent = '❌ Erro: ' + (d.error || 'Link inválido ou privado.');
        }
    } catch (e) {
        clearInterval(timer);
        status.textContent = '⚠️ Servidor Render a despertar. Aguarde 15s e toque novamente no botão.';
    }
}

function cortarVideoLocal() {
    const input = document.getElementById('videoLocal');
    const status = document.getElementById('statusDiv');
    const lista = document.getElementById('listaCortes');
    
    if (!input.files || !input.files[0]) {
        alert('Toque em Escolher ficheiro e selecione um vídeo da galeria!');
        return;
    }

    const file = input.files[0];
    status.style.display = 'block';
    status.textContent = '⏳ A dividir vídeo...';
    lista.innerHTML = '';

    const modo = document.getElementById('modoCorte').value;
    let partes = 3;
    if (modo === 'partes') {
        partes = Math.max(1, parseInt(document.getElementById('numPartes').value) || 3);
    } else {
        const seg = Math.max(5, parseInt(document.getElementById('segTempo').value) || 30);
        partes = Math.max(2, Math.ceil(120 / seg));
    }

    const total = file.size;
    for (let i = 0; i < partes; i++) {
        const ini = Math.floor((i / partes) * total);
        const fim = Math.floor(((i + 1) / partes) * total);
        const pedaco = file.slice(ini, fim, 'video/mp4');
        const urlBlob = URL.createObjectURL(pedaco);

        const item = document.createElement('div');
        item.className = 'clip-item';
        item.innerHTML = '<span>🎬 Parte ' + (i + 1) + ' de ' + partes + ' (' + (pedaco.size / 1048576).toFixed(1) + ' MB)</span>' +
                         '<a class="btn-verde" href="' + urlBlob + '" download="parte_' + (i + 1) + '.mp4">💾 Baixar Parte ' + (i + 1) + '</a>';
        lista.appendChild(item);
    }
    status.textContent = '✅ ' + partes + ' partes geradas com sucesso!';
}
</script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; font-family: sans-serif; }
body { background: #07090e; color: #fff; padding: 15px; display: flex; justify-content: center; }
.box { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 14px; }
.badge { background: #10b981; color: #000; font-weight: bold; padding: 6px 12px; border-radius: 20px; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; }
h1 { text-align: center; font-size: 26px; }
.tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; background: #111827; padding: 5px; border-radius: 12px; }
.tab { background: transparent; color: #94a3b8; border: none; padding: 12px; border-radius: 8px; font-weight: bold; font-size: 15px; cursor: pointer; }
.tab.active { background: #6366f1; color: #fff; }
.card { background: #111827; border: 1px solid #262f40; border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
label { font-size: 12px; color: #94a3b8; font-weight: bold; text-transform: uppercase; display: block; margin-bottom: 5px; }
input, select { width: 100%; padding: 12px; background: #030712; border: 1px solid #334155; color: #fff; border-radius: 10px; font-size: 15px; }
.btn-roxo { background: #6366f1; color: #fff; border: none; padding: 15px; border-radius: 10px; font-weight: bold; font-size: 16px; cursor: pointer; width: 100%; }
.btn-verde { background: #10b981; color: #000; text-decoration: none; text-align: center; padding: 13px; border-radius: 10px; font-weight: bold; font-size: 15px; display: block; width: 100%; }
.status { background: #1e293b; padding: 10px; border-radius: 8px; text-align: center; font-size: 14px; display: none; }
.clip-item { background: #1e293b; padding: 12px; border-radius: 10px; display: flex; flex-direction: column; gap: 8px; font-weight: bold; font-size: 14px; }
</style>
</head>
<body>
<div class="box">
    <div class="badge">⚡ VERSÃO 3.0 ATIVA</div>
    <h1>CortePro</h1>

    <div class="tabs">
        <button id="btn-aba-web" class="tab active" onclick="mudarAba('web')">📥 Baixar Web</button>
        <button id="btn-aba-div" class="tab" onclick="mudarAba('divisor')">✂️ Divisor</button>
    </div>

    <!-- ABA WEB -->
    <div id="aba-web" class="card">
        <div>
            <label>Link do Vídeo (TikTok, Kwai, Instagram, FB)</label>
            <input type="text" id="urlInput" placeholder="Cole o link aqui...">
        </div>
        <button class="btn-roxo" onclick="extrairWeb()">Extrair Vídeo com Áudio</button>
        <div id="statusWeb" class="status"></div>
        <div id="resWeb" style="display:none; flex-direction:column; gap:10px;">
            <video id="playerWeb" style="width:100%; max-height:200px; border-radius:8px; background:#000;" controls playsinline></video>
            <a id="linkDireto" class="btn-verde" href="#" target="_blank" download="video_cortepro.mp4">💾 Baixar Vídeo na Galeria</a>
        </div>
    </div>

    <!-- ABA DIVISOR -->
    <div id="aba-divisor" class="card" style="display:none;">
        <div>
            <label>1. Escolha o Vídeo do Telemóvel</label>
            <input type="file" id="videoLocal" accept="video/*">
        </div>
        <div>
            <label>2. Modo de Divisão</label>
            <select id="modoCorte" onchange="mudarModo()">
                <option value="partes">Dividir por Quantidade de Partes</option>
                <option value="tempo">Dividir por Segundos</option>
            </select>
        </div>
        <div id="boxPartes">
            <label>Quantidade de Partes</label>
            <input type="number" id="numPartes" value="3" min="1" max="20">
        </div>
        <div id="boxTempo" style="display:none;">
            <label>Segundos por Parte</label>
            <input type="number" id="segTempo" value="30" min="5" max="300">
        </div>
        <button class="btn-roxo" onclick="cortarVideoLocal()">✂️ Dividir Vídeo Agora</button>
        <div id="statusDiv" class="status"></div>
        <div id="listaCortes" style="display:flex; flex-direction:column; gap:10px;"></div>
    </div>
</div>
</body>
</html>