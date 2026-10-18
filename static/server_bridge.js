/* Camada de servidor local: login simples, save na conta e salas de coop por convite. */
(() => {
  'use strict';
  const MP = window.MP;
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Falha no servidor (${response.status}).`);
    return data;
  };

  const accountStyle = document.createElement('style');
  accountStyle.textContent = `
    .mp-auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:4px 0 12px}
    .mp-auth-tabs button{padding:12px 8px;border:2px solid #383848;background:#101016;color:#8e8e9f;font:10px var(--px);cursor:pointer}
    .mp-auth-tabs button.selected{color:#f4d78d;border-color:#c89b3c;background:#211a12}
    .mp-config .mp-primary{width:100%;margin:4px 0 0;background:#4d171a;border-color:#9d4a3d;color:#fff}
    .mp-config .mp-primary:hover{background:#6a2024;border-color:#e0b55c}
    .mp-invite-label{display:flex;flex-direction:column;gap:5px;color:#c89b3c;font:9px var(--px)}
    .mp-invite-label input{width:100%;padding:10px;background:#08080d;color:#f0d27f;border:1px solid #8b692d;font:16px var(--rt);user-select:text}
    #mp-create-room{width:100%;}
    #mp-code{width:100%;max-width:none;text-align:center;letter-spacing:2px;text-transform:uppercase;}
    .mp-config input{user-select:text;}
    @media(max-width:560px){.mp-auth-tabs button{font-size:8px}.mp-config .mp-primary{min-height:44px}}
  `;
  document.head.appendChild(accountStyle);

  MP.client = null;
  MP.socket = null;
  MP.channel = null;
  MP.user = null;
  MP.room = null;
  MP.host = false;
  MP.players = [];
  MP.battle = null;
  MP.roomStatus = 'Offline';
  MP.cloudSaveReady = false;
  MP.authMode = 'signin';
  MP.notice = '';
  MP.emailDraft = '';
  MP.nameDraft = '';
  MP._saveTimer = null;
  MP._socketBound = false;
  MP._inviteHandled = false;

  MP.localPlayerPayload = function () {
    const c = (typeof G !== 'undefined' && G.char) || { id: 'campones', hp: 100, mp: 30, str: 8 };
    const s = (typeof G !== 'undefined' && G.s) || {};
    return {
      classId: c.id || 'campones',
      hp: s.hp ?? c.hp ?? 100,
      maxHp: s.maxHp ?? c.hp ?? 100,
      mp: s.mp ?? c.mp ?? 30,
      maxMp: s.maxMp ?? c.mp ?? 30,
      dmg: typeof G !== 'undefined' && G.s ? G.dmg() : (c.str || 8),
      stage: s.stage || 1,
      role: c.id === 'medica' ? 'Suporte' : c.id === 'mago' ? 'Mago' : 'Aventureiro'
    };
  };

  MP.ensureClient = async function () {
    if (!this.user) throw new Error('Entre na sua conta para jogar online.');
    await this.ensureSocket();
  };

  MP.ensureSocket = async function () {
    if (!this.socket) {
      if (typeof window.io !== 'function') throw new Error('O cliente de conexão não carregou. Atualize a página.');
      this.socket = window.io({ autoConnect: false, reconnection: true, reconnectionAttempts: 8, timeout: 8000 });
      const sock = this.socket;
      sock.on('room_roster', data => {
        if (!data || (data.code !== this.room && data.code !== this._joiningRoom)) return;
        this.room = data.code;
        this.players = Array.isArray(data.players) ? data.players : [];
        this.host = data.hostId === this.user?.id;
        this.roomStatus = 'Conectado';
        this.channel = this.channel || { untrack: async () => sock.emit('room_leave') };
        this.renderRoster();
        if (this.host && this.battle && !this.battle.ended) this.ensureBattlePlayers();
      });
      sock.on('coop_message', packet => this.receive(packet));
      sock.on('room_error', data => this.onlinePanel(data?.message || 'Ocorreu um erro na sala.'));
      sock.on('connect_error', () => {
        this.roomStatus = 'Desconectado';
      });
      sock.on('connect', () => {
        this.roomStatus = 'Online';
        // Tenta voltar à sala em caso de reconexão momentânea.
        if (this.room && this.user) {
          const code = this.room;
          this._joiningRoom = code;
          sock.emit('room_join', { code, player: this.localPlayerPayload() }, result => {
            this._joiningRoom = null;
            if (result?.ok) {
              this.room = result.code;
              this.host = result.hostId === this.user?.id;
              this.players = result.players || [];
              this.roomStatus = 'Reconectado';
              this.renderRoster();
            }
          });
        }
      });
    }
    if (this.socket.connected) return true;
    const sock = this.socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.off('connect', onConnect);
        sock.off('connect_error', onError);
        err ? reject(err) : resolve(true);
      };
      const onConnect = () => finish();
      const onError = () => finish(new Error('Não foi possível conectar ao servidor. Verifique se ele está ligado e tente novamente.'));
      const timer = setTimeout(() => finish(new Error('O servidor demorou a responder. Tente de novo.')), 9000);
      sock.once('connect', onConnect);
      sock.once('connect_error', onError);
      sock.connect();
    });
    return true;
  };

  MP.auth = async function (mode) {
    try {
      const email = $('mp-email')?.value.trim() || this.emailDraft || '';
      const password = $('mp-password')?.value || '';
      const username = $('mp-name')?.value.trim() || this.nameDraft || '';
      this.emailDraft = email;
      this.nameDraft = username;
      if (!email || !password) throw new Error('Informe seu e-mail e sua senha.');
      if (mode === 'signup' && username.length < 2) throw new Error('Escolha um nome de jogador com pelo menos 2 caracteres.');
      const endpoint = mode === 'signup' ? '/api/auth/register' : '/api/auth/login';
      const body = mode === 'signup' ? { username, email, password } : { email, password };
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      this.user = result.user;
      this.emailDraft = result.user.email || email;
      this.nameDraft = result.user.username || username;
      this.client = { backend: 'Sols RNG server' };
      this.notice = result.message || 'Conta conectada.';
      await this.ensureSocket();
      await this.afterLogin({ preserveLocal: mode === 'signup' });
      this.authMode = 'signin';
      this.onlinePanel(this.notice);
    } catch (error) {
      this.notice = error.message || 'Não foi possível entrar na conta.';
      this.onlinePanel(this.notice);
    }
  };

  MP.afterLogin = async function ({ preserveLocal = false, fromBoot = false } = {}) {
    if (!this.user) return;
    this.cloudSaveReady = false;
    const result = await api('/api/save');
    const saved = result.save_data || {};
    const serverHasData = typeof saved.save === 'string' || typeof saved.meta === 'string';
    if (serverHasData) {
      if (typeof saved.save === 'string') localStorage.setItem('solrng_save', saved.save);
      else localStorage.removeItem('solrng_save');
      if (typeof saved.meta === 'string') localStorage.setItem('solrng_meta', saved.meta);
      else localStorage.removeItem('solrng_meta');
    } else if (preserveLocal) {
      // Ao criar a conta, transforma o progresso local atual em progresso da conta.
      await this.syncCloudSave();
    } else {
      // Uma conta diferente não deve herdar dados locais de outra pessoa.
      localStorage.removeItem('solrng_save');
      localStorage.removeItem('solrng_meta');
    }
    this.cloudSaveReady = true;
    if (typeof Meta !== 'undefined') {
      Meta.load();
      Meta.profileName = this.user.username || this.user.email?.split('@')[0] || 'Aventureiro';
      Meta.save();
    }
    if (typeof G !== 'undefined' && typeof G.init2 === 'function') G.init2();
    const invite = new URLSearchParams(location.search).get('room');
    if (invite && !this._inviteHandled) {
      this._inviteHandled = true;
      this.ensureRunForCoop();
      await this.joinRoom(invite, false);
    }
  };

  MP.syncCloudSave = async function () {
    if (!this.user || !this.client) return;
    await api('/api/save', {
      method: 'PUT',
      body: JSON.stringify({
        save: localStorage.getItem('solrng_save'),
        meta: localStorage.getItem('solrng_meta')
      })
    });
    this.cloudSaveReady = true;
  };

  MP.queueCloudSave = function () {
    if (!this.user || !this.client || !this.cloudSaveReady) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.syncCloudSave().catch(() => {
      this.cloudSaveReady = false;
      this.roomStatus = 'Save aguardando conexão';
    }), 800);
  };

  MP.logout = async function () {
    try {
      if (this.socket?.connected) {
        this.socket.emit('room_leave');
        this.socket.disconnect();
      }
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch (_) {
      // Mesmo sem resposta do servidor, encerra a sessão visualmente.
    }
    this.user = null;
    this.client = null;
    this.channel = null;
    this.room = null;
    this.host = false;
    this.players = [];
    this.battle = null;
    this.roomStatus = 'Offline';
    this.authMode = 'signin';
    this.onlinePanel('Você saiu da conta. O progresso salvo nela permanece guardado.');
  };

  MP.ensureRunForCoop = function () {
    if (typeof G !== 'undefined' && G.s && G.runActive) return true;
    if (localStorage.getItem('solrng_save') && typeof G.load === 'function') {
      if (G.load() && G.s) return true;
    }
    const starter = CHARS.find(c => c.id === 'campones') || CHARS[0];
    if (!starter) throw new Error('Não consegui preparar uma partida inicial. Atualize a página.');
    G.diff = 'medium';
    G.start(starter);
    return true;
  };

  MP.createRoom = async function () {
    try {
      await this.ensureClient();
      this.ensureRunForCoop();
      this.roomStatus = 'Criando sala…';
      this.onlinePanel('Criando uma sala segura para o seu grupo…');
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('O servidor não respondeu ao criar a sala.')), 9000);
        this.socket.emit('room_create', { player: this.localPlayerPayload() }, response => {
          clearTimeout(timer);
          resolve(response || { ok: false, error: 'Não foi possível criar a sala.' });
        });
      });
      if (!result.ok) throw new Error(result.error || 'Não foi possível criar a sala.');
      this.room = result.code;
      this._joiningRoom = null;
      this.host = true;
      this.players = result.players || [];
      this.roomStatus = 'Conectado';
      this.channel = { untrack: async () => this.socket?.emit('room_leave') };
      this.renderRoster();
      await this.copyRoom();
    } catch (error) {
      this.onlinePanel(error.message || 'Não foi possível criar a sala.');
    }
  };

  MP.joinRoom = async function (code, _host = false) {
    try {
      await this.ensureClient();
      this.ensureRunForCoop();
      code = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Digite o código de 6 letras/números que seu amigo compartilhou.');
      this._joiningRoom = code;
      this.roomStatus = 'Entrando na sala…';
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('O servidor não respondeu ao entrar na sala.')), 9000);
        this.socket.emit('room_join', { code, player: this.localPlayerPayload() }, response => {
          clearTimeout(timer);
          resolve(response || { ok: false, error: 'Não foi possível entrar na sala.' });
        });
      });
      this._joiningRoom = null;
      if (!result.ok) throw new Error(result.error || 'Não foi possível entrar na sala.');
      this.room = result.code;
      this.host = result.hostId === this.user.id;
      this.players = result.players || [];
      this.roomStatus = 'Conectado';
      this.channel = { untrack: async () => this.socket?.emit('room_leave') };
      this.renderRoster();
      this.onlinePanel(`Você entrou na sala ${this.room}. O grupo está pronto para se aventurar.`);
    } catch (error) {
      this._joiningRoom = null;
      this.onlinePanel(error.message || 'Não foi possível entrar na sala.');
    }
  };

  MP.updatePresence = async function () {
    if (!this.socket?.connected || !this.room || !this.user) return;
    this.socket.emit('player_update', this.localPlayerPayload());
  };

  MP.refreshRoster = function () { this.renderRoster(); };
  MP.renderRoster = function () {
    const el = $('mp-roster');
    if (el) {
      el.innerHTML = this.players.map(p => `<div class="mp-player"><span class="mp-online"></span><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(CHARS.find(c => c.id === p.classId)?.n || p.classId || 'Aventureiro')} · ${escapeHtml(p.role || 'Aventureiro')}${p.userId === this.user?.id ? ' · Você' : ''}</small></div>`).join('') || '<p>Aguardando jogadores… Compartilhe o convite para começar.</p>';
    }
    const status = $('mp-room-status');
    if (status) status.textContent = this.room ? `Sala ${this.room} · ${this.players.length}/3 jogadores · ${this.roomStatus}${this.host ? ' · anfitrião' : ''}` : 'Nenhuma sala conectada.';
    const create = $('mp-create-room');
    if (create) create.disabled = !this.user;
    const join = $('mp-join-room');
    if (join) join.disabled = !this.user;
    const copy = $('mp-copy');
    if (copy) copy.disabled = !this.room;
    const start = $('mp-start-boss');
    if (start) start.disabled = !(this.host && this.players.length >= 2 && (!this.battle || this.battle.ended));
    const resume = $('mp-resume-boss');
    if (resume) resume.disabled = !(this.battle && !this.battle.ended);
  };

  MP.send = async function (type, data = {}) {
    if (!this.socket?.connected || !this.room) return;
    this.socket.emit('coop_send', { payload: { type, from: this.user?.id, ...data } });
  };

  MP.leaveRoom = async function () {
    if (this.socket?.connected && this.room) this.socket.emit('room_leave');
    this.channel = null;
    this.room = null;
    this.host = false;
    this.players = [];
    this.battle = null;
    this.roomStatus = 'Offline';
    this.onlinePanel('Você saiu da sala. A sua partida local continua disponível.');
  };

  MP.copyRoom = async function () {
    if (!this.room) return;
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(location.hostname.toLowerCase());
    if (isLoopback) {
      let copied = false;
      try { await navigator.clipboard.writeText(this.room); copied = true; } catch (_) { copied = false; }
      const input = $('mp-invite-link');
      if (input) { input.value = this.room; input.focus(); input.select(); }
      this.onlinePanel(copied
        ? `Código ${this.room} copiado. Para jogar na mesma Wi-Fi, seu amigo deve abrir http://IP-DO-SEU-PC:5000 e digitar esse código. Para enviar um link direto, abra o jogo pelo IP da rede antes de criar a sala.`
        : `Código da sala: ${this.room}. Para jogar na mesma Wi-Fi, seu amigo deve abrir http://IP-DO-SEU-PC:5000 e digitar esse código.`);
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('room', this.room);
    const invite = url.toString();
    let copied = false;
    try { await navigator.clipboard.writeText(invite); copied = true; } catch (_) { copied = false; }
    this.onlinePanel(copied ? `Link de convite copiado! Envie para seu amigo: ${this.room}.` : 'Copie o link no campo de convite abaixo e envie aos seus amigos.');
    const input = $('mp-invite-link');
    if (input) { input.value = invite; input.focus(); input.select(); }
  };

  MP.setAuthMode = function (mode) {
    this.authMode = mode === 'signup' ? 'signup' : 'signin';
    this.onlinePanel();
  };

  MP.onlinePanel = function (message = '') {
    if (message) this.notice = message;
    const connected = !!this.user;
    const inviteIsLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname.toLowerCase());
    const inviteUrl = this.room && !inviteIsLocal ? (() => { const u = new URL(location.href); u.searchParams.set('room', this.room); return u.toString(); })() : '';
    const account = connected ? `
      <div class="mp-status"><span class="mp-online"></span><strong>Conectado como ${escapeHtml(this.user.username || this.user.email)}</strong><small>${escapeHtml(this.user.email || '')}</small><small>Seu progresso é salvo na conta automaticamente.</small></div>
      <div class="row"><button class="btn" onclick="MP.syncCloudSave().then(()=>MP.onlinePanel('Progresso sincronizado com sucesso.')).catch(e=>MP.onlinePanel(e.message))">SINCRONIZAR SAVE</button><button class="btn" onclick="MP.logout()">SAIR DA CONTA</button></div>` : `
      <div class="mp-auth-tabs"><button class="${this.authMode === 'signin' ? 'selected' : ''}" onclick="MP.setAuthMode('signin')">ENTRAR</button><button class="${this.authMode === 'signup' ? 'selected' : ''}" onclick="MP.setAuthMode('signup')">CRIAR CONTA</button></div>
      <div class="mp-config">
        ${this.authMode === 'signup' ? '<label>NOME NO JOGO<input id="mp-name" maxlength="24" autocomplete="nickname" placeholder="Como seus amigos vão te ver" value="' + escapeHtml(this.nameDraft) + '"></label>' : ''}
        <label>E-MAIL<input id="mp-email" type="email" maxlength="254" autocomplete="email" placeholder="voce@exemplo.com" value="${escapeHtml(this.emailDraft)}"></label>
        <label>SENHA<input id="mp-password" type="password" minlength="8" maxlength="200" autocomplete="${this.authMode === 'signup' ? 'new-password' : 'current-password'}" placeholder="${this.authMode === 'signup' ? 'Pelo menos 8 caracteres' : 'Sua senha'}"></label>
        <button class="btn mp-primary" onclick="MP.auth('${this.authMode}')">${this.authMode === 'signup' ? 'CRIAR CONTA E ENTRAR' : 'ENTRAR NO JOGO'}</button>
        <p>${this.authMode === 'signup' ? 'Sem confirmação por e-mail: a conta entra automaticamente. Use uma senha que você não usa em outros sites.' : 'Seu save fica vinculado à sua conta, mesmo que você troque de computador.'}</p>
      </div>`;
    G.modal('CONTA & COOP ONLINE', `
      <div class="mp-status"><span class="mp-online ${connected ? '' : 'offline'}"></span><strong>${connected ? 'Conta conectada' : 'Entre para jogar com seus amigos'}</strong><small>${escapeHtml(this.notice || (connected ? this.roomStatus : 'Crie a conta uma vez e use o mesmo e-mail para entrar depois.'))}</small></div>
      ${account}
      <hr style="border-color:var(--line)">
      <div class="mp-room">
        <div class="h">JOGAR JUNTO · ATÉ 3 JOGADORES</div>
        <p class="mp-note">Crie uma sala e convide seus amigos. ${inviteIsLocal ? 'Como você está usando localhost, amigos na mesma Wi-Fi devem abrir o IP deste computador na porta 5000 e digitar o código. Para um link direto, abra o jogo usando o IP da rede antes de criar a sala.' : 'Envie o link: seu amigo entra ou cria a conta e é encaminhado direto para a sala.'}</p>
        <div id="mp-room-status">${this.room ? `Sala ${this.room} · ${this.players.length}/3 jogadores` : 'Nenhuma sala conectada.'}</div>
        <div class="row"><button id="mp-create-room" class="btn" ${connected ? '' : 'disabled'} onclick="MP.createRoom()">CRIAR SALA + CONVITE</button></div>
        <div class="row"><input id="mp-code" maxlength="6" placeholder="CÓDIGO DA SALA" value="${escapeHtml(this.room || '')}" aria-label="Código da sala"><button id="mp-join-room" class="btn" ${connected ? '' : 'disabled'} onclick="MP.joinRoom($('mp-code').value,false)">ENTRAR NA SALA</button></div>
        ${this.room ? `<label class="mp-invite-label">${inviteIsLocal ? 'CÓDIGO DA SALA' : 'LINK PARA OS AMIGOS'}<input id="mp-invite-link" readonly value="${escapeHtml(inviteIsLocal ? this.room : inviteUrl)}" onclick="this.select()"></label><button id="mp-copy" class="btn" onclick="MP.copyRoom()">${inviteIsLocal ? 'COPIAR CÓDIGO DA SALA' : 'COPIAR LINK DE CONVITE'}</button>` : '<p class="mp-note">Você pode criar ou entrar na sala sem configurar chaves nem serviços externos.</p>'}
        <div id="mp-roster" class="mp-roster">${this.players.map(p => `<div class="mp-player"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.classId || 'Aventureiro')}</small></div>`).join('') || '<p>A sala mostrará aqui quem estiver conectado.</p>'}</div>
        <button id="mp-resume-boss" class="btn" ${this.battle && !this.battle.ended ? '' : 'disabled'} onclick="MP.showBoss()">RETOMAR CHEFE COOPERATIVO</button>
        <button id="mp-start-boss" class="btn" ${this.host && this.players.length >= 2 && (!this.battle || this.battle.ended) ? '' : 'disabled'} onclick="MP.startBoss()">INICIAR CHEFE EM EQUIPE</button>
        ${this.room ? '<button class="btn" onclick="MP.leaveRoom()">SAIR DA SALA</button>' : ''}
      </div>
      <button class="btn" onclick="G.closeModal()">VOLTAR AO JOGO</button>`);
    this.renderRoster();
  };

  // Flush do último save ao fechar a aba, para reduzir a chance de perder a última alteração.
  window.addEventListener('pagehide', () => {
    try {
      if (typeof G !== 'undefined' && G.s && G.runActive) G.save(false);
      if (MP.user && MP.client) {
        const body = JSON.stringify({ save: localStorage.getItem('solrng_save'), meta: localStorage.getItem('solrng_meta') });
        fetch('/api/save', { method: 'PUT', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
      }
    } catch (_) {}
  });

  // Evita recarregar configuração de serviços de terceiros; tudo usa o servidor deste projeto.
  G.multiplayer = function () { if (MP.channel) MP.updatePresence(); MP.onlinePanel(); };

  window.addEventListener('load', async () => {
    try {
      const result = await api('/api/me');
      if (result.user) {
        MP.user = result.user;
        MP.client = { backend: 'Sols RNG server' };
        await MP.ensureSocket();
        await MP.afterLogin({ fromBoot: true });
      }
      const invite = new URLSearchParams(location.search).get('room');
      if (invite && !MP.user) {
        MP.notice = `Você recebeu um convite para a sala ${invite}. Entre ou crie uma conta para continuar.`;
        MP.onlinePanel(MP.notice);
      }
      const appTitle = document.querySelector('title');
      if (appTitle) appTitle.textContent = "Sol's RNG — Dark Fantasy";
    } catch (_) {
      MP.notice = 'Não consegui alcançar o servidor local. Confira se a janela do servidor continua aberta.';
      const invite = new URLSearchParams(location.search).get('room');
      if (invite) MP.onlinePanel(MP.notice);
    }
  });
})();
