const $ = (s) => document.querySelector(s);
const names = { "tic-tac-toe": "Gato", snake: "Snake", racing: "Circuito" };
const tags = {
  "tic-tac-toe": "ESTRATEGIA · TÚ CONTRA PROLOG",
  snake: "REFLEJOS · UN JUGADOR",
  racing: "VELOCIDAD · TRES VUELTAS",
};
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function api(route, method = "GET", data) {
  const r = await fetch("/api" + route, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(result.error || "No se pudo completar la solicitud.");
  return result;
}
let noticeTimer;
function notice(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("#notice").hidden = true), 6500);
}
class GameConsole {
  constructor() {
    this.current = null;
    this.view = "library";
    this.sessions = [];
    this.paused = false;
    this.busy = false;
    this.direction = "right";
    this.keys = new Set();
    this.lastTick = 0;
    this.metricsBusy = false;
    this.bind();
    this.refreshSessions();
    this.dashboard();
    this.poll = setInterval(() => {
      this.refreshSessions();
      this.dashboard();
      if (this.current) this.results();
    }, 2500);
    this.loop = setInterval(() => this.tick(), 110);
    const q = new URLSearchParams(location.search);
    if (q.get("game") && names[q.get("game")]) this.start(q.get("game"));
    else if (q.get("match")) this.open(q.get("match"));
  }
  bind() {
    document
      .querySelectorAll("[data-start]")
      .forEach((b) =>
        b.addEventListener("click", () => this.start(b.dataset.start)),
      );
    document
      .querySelectorAll("[data-view]")
      .forEach((b) =>
        b.addEventListener("click", () => this.show(b.dataset.view)),
      );
    $("#back-library").onclick = () => this.show("library");
    $("#refresh-sessions").onclick = () => this.refreshSessions();
    $("#pause-game").onclick = () => {
      this.paused = !this.paused;
      this.render();
    };
    $("#finish-game").onclick = () => this.finish();
    $("#new-tab").onclick = () => {
      if (this.current)
        window.open("/?game=" + this.current.gameId, "_blank", "noopener");
    };
    $("#play-again").onclick = () => this.start(this.current.gameId);
    $("#retry-ai").onclick = () => this.action({ retryAI: true });
    document.addEventListener("keydown", (e) => {
      if (
        this.view !== "play" ||
        !this.current ||
        e.target.matches("input,textarea")
      )
        return;
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)
      )
        e.preventDefault();
      this.keys.add(e.key);
      const map = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        w: "up",
        s: "down",
        a: "left",
        d: "right",
      };
      if (map[e.key]) this.direction = map[e.key];
      if (this.current.gameId === "racing" && !e.repeat) {
        if (e.key === "ArrowLeft" || e.key === "a")
          this.current.lane = Math.max(0, this.current.lane - 1);
        if (e.key === "ArrowRight" || e.key === "d")
          this.current.lane = Math.min(2, this.current.lane + 1);
      }
      if (e.key === " ") {
        this.paused = !this.paused;
        this.render();
      }
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.key));
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.keys.clear();
    });
  }
  show(view) {
    this.view = view;
    for (const name of ["library", "stats", "play"])
      $("#" + name + "-view").hidden = name !== view;
    document
      .querySelectorAll("[data-view]")
      .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#breadcrumb").textContent =
      "Tu espacio / " +
      { library: "Biblioteca", stats: "Estadísticas", play: "En partida" }[
        view
      ];
    if (view === "stats") this.dashboard();
    if (view !== "play") {
      this.paused = true;
      this.keys.clear();
    } else this.render();
  }
  async start(gameId) {
    try {
      const m = await api("/matches", "POST", { gameId });
      this.current = m;
      this.paused = gameId !== "tic-tac-toe";
      this.keys.clear();
      this.direction = "right";
      this.show("play");
      this.mount();
      this.refreshSessions();
      history.replaceState(null, "", "/?match=" + m.id);
    } catch (e) {
      notice(e.message);
    }
  }
  async open(id) {
    try {
      this.current = await api("/matches/" + id);
      this.paused = this.current.gameId !== "tic-tac-toe";
      this.direction = this.current.direction || "right";
      this.show("play");
      this.mount();
    } catch (e) {
      notice(e.message);
    }
  }
  async finish() {
    if (!this.current) return;
    try {
      const id = this.current.id;
      const m = await api("/matches/" + id + "/finish", "POST", {});
      if (this.current?.id === id) {
        this.current = m;
        this.render();
      }
      this.refreshSessions();
      this.dashboard();
    } catch (e) {
      notice(e.message);
    }
  }
  async action(data) {
    if (this.busy || !this.current || this.current.state === "closed") return;
    this.busy = true;
    const id = this.current.id;
    try {
      const m = await api("/matches/" + id + "/action", "POST", data);
      if (this.current?.id === id) {
        this.current = m;
        this.render();
      }
    } catch (e) {
      this.paused = true;
      notice(e.message);
      try {
        const m = await api("/matches/" + id);
        if (this.current?.id === id) {
          this.current = m;
          this.render();
        }
      } catch {}
    } finally {
      this.busy = false;
    }
  }
  tick() {
    const m = this.current;
    if (
      !m ||
      this.view !== "play" ||
      this.paused ||
      document.hidden ||
      m.state === "closed" ||
      this.busy
    )
      return;
    if (m.gameId === "snake" && Date.now() - this.lastTick >= 150) {
      this.lastTick = Date.now();
      this.action({ direction: this.direction });
    } else if (m.gameId === "racing")
      this.action({
        lane: m.lane,
        accelerate:
          this.keys.has("ArrowUp") ||
          this.keys.has("w") ||
          this.touchAccelerate ||
          false,
        brake:
          this.keys.has("ArrowDown") ||
          this.keys.has("s") ||
          this.touchBrake ||
          false,
      });
  }
  mount() {
    const stage = $("#play-stage");
    stage.replaceChildren();
    stage.classList.toggle(
      "has-controls",
      this.current.gameId !== "tic-tac-toe",
    );
    if (this.current.gameId === "tic-tac-toe") {
      const board = document.createElement("div");
      board.className = "board";
      board.setAttribute("aria-label", "Tablero de Gato");
      for (let i = 0; i < 9; i++) {
        const b = document.createElement("button");
        b.setAttribute(
          "aria-label",
          `Fila ${Math.floor(i / 3) + 1}, columna ${(i % 3) + 1}`,
        );
        b.onclick = () => this.action({ index: i });
        board.append(b);
      }
      stage.append(board);
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = this.current.gameId === "snake" ? 440 : 420;
      canvas.height = this.current.gameId === "snake" ? 440 : 480;
      canvas.setAttribute(
        "aria-label",
        this.current.gameId === "snake"
          ? "Tablero Snake. Usa flechas o controles de dirección."
          : "Pista de carreras. Usa arriba para acelerar y lados para cambiar carril.",
      );
      canvas.tabIndex = 0;
      stage.append(canvas);
      const controls = document.createElement("div");
      controls.className = "touch-controls";
      const config =
        this.current.gameId === "snake"
          ? [
              ["←", "left"],
              ["↑", "up"],
              ["↓", "down"],
              ["→", "right"],
            ]
          : [
              ["←", "laneLeft"],
              ["Acelerar", "gas"],
              ["Frenar", "brake"],
              ["→", "laneRight"],
            ];
      for (const [label, key] of config) {
        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("aria-label", key);
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          b.setPointerCapture(e.pointerId);
          if (key === "gas") this.touchAccelerate = true;
          else if (key === "brake") this.touchBrake = true;
          else if (key === "laneLeft")
            this.current.lane = Math.max(0, this.current.lane - 1);
          else if (key === "laneRight")
            this.current.lane = Math.min(2, this.current.lane + 1);
          else this.direction = key;
        });
        for (const event of [
          "pointerup",
          "pointercancel",
          "lostpointercapture",
        ])
          b.addEventListener(event, () => {
            if (key === "gas") this.touchAccelerate = false;
            if (key === "brake") this.touchBrake = false;
          });
        controls.append(b);
      }
      stage.append(controls);
    }
    this.render();
    this.results();
  }
  render() {
    const m = this.current;
    if (!m) return;
    $("#play-title").textContent = names[m.gameId];
    $("#play-tag").textContent = tags[m.gameId];
    $("#match-code").textContent = "PARTIDA " + m.id;
    $("#play-again").hidden = m.state !== "closed";
    $("#pause-game").hidden =
      m.gameId === "tic-tac-toe" || m.state === "closed";
    $("#pause-game").textContent = this.paused ? "Continuar" : "Pausar";
    $("#finish-game").disabled = m.state === "closed";
    $("#retry-ai").hidden =
      m.gameId !== "tic-tac-toe" || m.state === "closed" || m.turn % 2 !== 1;
    const outcomes = {
      human_won: "¡Ganaste!",
      prolog_won: "Prolog gana esta vez",
      draw: "Un empate perfecto",
      game_over: "Fin de la partida",
      race_completed: "¡Meta completada!",
      abandoned: "Partida finalizada",
      shutdown: "Sesión finalizada",
      board_completed: "¡Tablero completo!",
    };
    $("#play-status").textContent =
      m.state === "closed"
        ? outcomes[m.result] || "Partida finalizada"
        : m.gameId === "tic-tac-toe"
          ? m.turn % 2
            ? "Prolog está pensando"
            : "Tu turno · X"
          : this.paused
            ? "Listo cuando tú quieras"
            : "Partida en marcha";
    $("#play-instructions").textContent =
      m.gameId === "tic-tac-toe"
        ? "Elige una casilla. Tú juegas con X y Prolog con O. Completa una línea de tres para ganar."
        : m.gameId === "snake"
          ? "Pulsa Continuar. Usa las flechas o WASD para moverte. Cada manzana vale 10 puntos. Espacio para pausar."
          : "Pulsa Continuar. Mantén ↑ o W para acelerar; ↓ o S para frenar. Usa ← y → para cambiar de carril. Completa tres vueltas.";
    $("#play-score").textContent =
      m.gameId === "snake"
        ? `${m.points} puntos`
        : m.gameId === "racing"
          ? `${m.speed} km/h · ${Math.min(m.lap + 1, 3)}/3`
          : `${m.turn} movimientos`;
    $("#ai-explanation").textContent = m.lastDecision
      ? `Minimax exploró el tablero y eligió la casilla ${m.lastDecision.index + 1}. Evaluación: ${m.lastDecision.score} (10: victoria de O, 0: empate, −10: victoria de X).`
      : m.gameId === "racing"
        ? `Choques: ${m.collisions}. Cada obstáculo reduce tu velocidad.`
        : "";
    const d = m.delivery;
    $("#delivery-status").textContent = d
      ? d.error
        ? `Conexión pendiente · ${d.pending} eventos por entregar`
        : `${d.delivered} eventos entregados · ${d.pending} pendientes`
      : "Preparando eventos para GameStats";
    if (m.gameId === "tic-tac-toe") {
      document.querySelectorAll(".board button").forEach((b, i) => {
        b.textContent =
          m.board[i] === "X" ? "×" : m.board[i] === "O" ? "○" : "";
        b.className =
          (m.board[i] === "O" ? "o " : "") +
          (m.winningLine.includes(i) ? "win" : "");
        b.disabled = !!m.board[i] || m.state === "closed" || m.turn % 2 === 1;
      });
    } else if (m.gameId === "snake") this.drawSnake();
    else this.drawRace();
  }
  drawSnake() {
    const canvas = $("#play-stage canvas");
    if (!canvas) return;
    const c = canvas.getContext("2d"),
      m = this.current,
      u = canvas.width / m.size;
    c.fillStyle = "#151c19";
    c.fillRect(0, 0, 440, 440);
    c.strokeStyle = "#243128";
    c.lineWidth = 1;
    for (let i = 0; i <= m.size; i++) {
      c.beginPath();
      c.moveTo(i * u, 0);
      c.lineTo(i * u, 440);
      c.stroke();
      c.beginPath();
      c.moveTo(0, i * u);
      c.lineTo(440, i * u);
      c.stroke();
    }
    m.body.forEach((p, i) => {
      c.fillStyle = i === 0 ? "#d7ff9a" : "#9fc45b";
      c.beginPath();
      c.roundRect(p.x * u + 2, p.y * u + 2, u - 4, u - 4, 4);
      c.fill();
    });
    if (m.food) {
      c.fillStyle = "#ffab98";
      c.beginPath();
      c.arc((m.food.x + 0.5) * u, (m.food.y + 0.5) * u, 7, 0, Math.PI * 2);
      c.fill();
    }
    if (this.paused && m.state === "open")
      this.overlay(c, 440, 440, "EN PAUSA");
  }
  drawRace() {
    const canvas = $("#play-stage canvas");
    if (!canvas) return;
    const c = canvas.getContext("2d"),
      m = this.current;
    c.fillStyle = "#20252a";
    c.fillRect(0, 0, 420, 480);
    c.fillStyle = "#30303a";
    c.fillRect(60, 0, 300, 480);
    c.fillStyle = "#ffb58b";
    c.fillRect(54, 0, 6, 480);
    c.fillRect(360, 0, 6, 480);
    c.strokeStyle = "#7d7c89";
    c.lineWidth = 3;
    c.setLineDash([25, 24]);
    c.lineDashOffset = -(m.progress * 1.5) % 49;
    for (const x of [160, 260]) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, 480);
      c.stroke();
    }
    c.setLineDash([]);
    for (const o of m.obstacles) {
      const d = o.position - m.progress;
      if (d >= -55 && d < 520) {
        const y = 390 - d * 0.8;
        c.fillStyle = "#a77fff";
        c.beginPath();
        c.roundRect(85 + o.lane * 100, y - 15, 50, 30, 5);
        c.fill();
        c.fillStyle = "#d9c6ff";
        c.fillRect(90 + o.lane * 100, y - 5, 40, 5);
      }
    }
    const x = 87 + m.lane * 100;
    c.fillStyle = "#14141c";
    c.fillRect(x - 5, 355, 56, 15);
    c.fillRect(x - 5, 400, 56, 15);
    c.fillStyle = "#ffb58b";
    c.beginPath();
    c.roundRect(x, 347, 46, 76, 9);
    c.fill();
    c.fillStyle = "#473e4a";
    c.fillRect(x + 6, 359, 34, 18);
    c.fillRect(x + 6, 396, 34, 14);
    c.fillStyle = "#eee1cc";
    c.fillRect(x + 3, 351, 10, 5);
    c.fillRect(x + 33, 351, 10, 5);
    c.fillStyle = "#11121a";
    c.fillRect(76, 20, 268, 23);
    c.fillStyle = "#ffb58b";
    c.fillRect(80, 24, 260 * (m.progress / m.lapLength), 15);
    if (this.paused && m.state === "open")
      this.overlay(c, 420, 480, "EN PAUSA");
  }
  overlay(c, w, h, text) {
    c.fillStyle = "#11121aaa";
    c.fillRect(0, h / 2 - 35, w, 70);
    c.font = "600 19px Segoe UI";
    c.textAlign = "center";
    c.fillStyle = "#e5d9ff";
    c.fillText(text, w / 2, h / 2 + 7);
  }
  async refreshSessions() {
    try {
      this.sessions = await api("/matches");
      $("#session-count").textContent = String(this.sessions.length).padStart(
        2,
        "0",
      );
      $("#sessions").innerHTML = this.sessions.length
        ? this.sessions
            .slice(0, 15)
            .map(
              (m) =>
                `<div class="session-row"><div><div class="session-name">${names[m.gameId]}</div><div class="session-meta">${escape(m.id.slice(0, 8))} · ${m.state === "open" ? "En curso" : "Finalizada"} · ${m.delivery.pending ? "Envíos pendientes" : m.eventCount + " eventos"}</div></div><div class="session-actions"><button data-open="${m.id}">${m.state === "open" ? "Continuar" : "Ver partida"}</button></div></div>`,
            )
            .join("")
        : '<p class="empty">El siguiente reto empieza contigo. Abre tu primera partida.</p>';
      document
        .querySelectorAll("[data-open]")
        .forEach((b) => (b.onclick = () => this.open(b.dataset.open)));
      if (this.current) {
        const s = this.sessions.find((m) => m.id === this.current.id);
        if (s) {
          this.current.delivery = s.delivery;
          $("#delivery-status").textContent = s.delivery.error
            ? `Conexión pendiente · ${s.delivery.pending} eventos por entregar`
            : `${s.delivery.delivered} eventos entregados · ${s.delivery.pending} pendientes`;
        }
      }
    } catch {}
  }
  async dashboard() {
    if (this.dashboardBusy) return;
    this.dashboardBusy = true;
    try {
      const data = await api("/dashboard");
      $("#connection-dot").classList.add("online");
      $("#connection-text").textContent = "GameStats conectado";
      $("#stats-totals").innerHTML = [
        ["Instancias iniciadas", data.totals.started],
        ["En curso", data.totals.active],
        ["Finalizadas", data.totals.finished],
        ["Eventos recibidos", data.totals.events],
      ]
        .map(
          ([label, n]) =>
            `<div class="stat-tile"><span>${label}</span><strong>${n}</strong></div>`,
        )
        .join("");
      $("#stats-games").innerHTML = data.games
        .map(
          (g) =>
            `<article class="stats-game"><h3>${names[g.gameId] || escape(g.gameId)}</h3>${this.metric("Instancias", g.started)}${this.metric("En curso", g.active)}${this.metric("Finalizadas", g.finished)}${g.metrics.map((m) => this.metric(m.label + (m.invalidSamples ? " (parcial)" : ""), `${this.number(m.value)} ${m.unit === "events" ? "" : m.unit === "seconds" ? "s" : m.unit === "points" ? "pts" : m.unit}`)).join("")}</article>`,
        )
        .join("");
      $("#stats-updated").textContent =
        "Actualizado " + new Date().toLocaleTimeString("es-CR");
    } catch (e) {
      $("#connection-dot").classList.remove("online");
      $("#connection-text").textContent = "GameStats sin conexión";
      if (this.view === "stats" && !$("#stats-totals").children.length)
        $("#stats-games").textContent = e.message;
    } finally {
      this.dashboardBusy = false;
    }
  }
  metric(label, value) {
    return `<div class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`;
  }
  number(n) {
    return n == null
      ? "—"
      : new Intl.NumberFormat("es-CR", { maximumFractionDigits: 2 }).format(n);
  }
  async results() {
    if (this.metricsBusy || !this.current || this.view !== "play") return;
    this.metricsBusy = true;
    const id = this.current.id;
    try {
      const r = await api("/matches/" + id + "/results");
      if (this.current?.id !== id) return;
      $("#match-results").innerHTML =
        `<p>${r.state === "open" ? "Resultados provisionales" : "Resultados finales"}</p>` +
        r.metrics
          .map((m) =>
            this.metric(
              m.label +
                (m.scope === "player"
                  ? ` · ${m.subjectId === "human" ? "Tú" : m.subjectId === "prolog" ? "Prolog" : m.subjectId}`
                  : ""),
              m.status === "invalid"
                ? "Datos inválidos"
                : typeof m.value === "object" && m.value !== null
                  ? m.value.outcome === "win"
                    ? m.value.winnerId === "human"
                      ? "Ganaste"
                      : "Gana Prolog"
                    : m.value.outcome === "draw"
                      ? "Empate"
                      : "En curso"
                  : m.value == null
                    ? "Pendiente"
                    : this.number(m.value) +
                      (m.unit === "seconds"
                        ? " s"
                        : m.unit === "ms"
                          ? " ms"
                          : ""),
            ),
          )
          .join("") +
        r.patterns
          .map((p) =>
            this.metric(
              p.label,
              p.status === "invalid"
                ? "Datos inválidos"
                : p.count == null
                  ? "Pendiente"
                  : p.count,
            ),
          )
          .join("");
    } catch {
      if (this.current?.id === id)
        $("#match-results").textContent =
          "Esperando la recepción de eventos en GameStats.";
    } finally {
      this.metricsBusy = false;
    }
  }
}
new GameConsole();
