// Roundtable WebUI — vanilla JS.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ===== Theme =====
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("btn-theme");
    if (btn) btn.textContent = theme === "light" ? "☀️ 日间" : "🌙 夜间";
  }
  function initTheme() {
    const saved = localStorage.getItem("rt-theme");
    const sysLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(saved || (sysLight ? "light" : "dark"));
    const btn = document.getElementById("btn-theme");
    if (btn) {
      btn.addEventListener("click", () => {
        const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
        localStorage.setItem("rt-theme", next);
        applyTheme(next);
      });
    }
  }
  initTheme();

  const state = {
    groups: [],
    conversations: [],
    activeGroup: null,
    activeConv: null,
    participants: [],
    sse: null,
    expandedGroups: new Set(),
    groupAgents: new Map(), // groupId -> agents[]
    poolAgents: [],
    sectionCollapsed: { pool: false, groups: false, conversations: false },
    // scroll state for active conversation
    stickyBottom: true,
    pendingNewCount: 0,
    headerRefreshTimer: null,
    // round state
    roundActive: false,
  };

  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 401) {
      // Session expired or never authenticated — kick to login
      const back = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/auth/login?return_to=${back}`;
      // Throw to abort callers' chains
      throw new Error("unauthenticated");
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json();
  }

  async function init() {
    // 1) Verify session FIRST. /api/me 401 → redirect handled by api().
    let me;
    try {
      me = await api("GET", "/api/me");
    } catch {
      return; // either redirected or hard error already shown
    }
    renderUserBadge(me);

    try {
      await api("GET", "/api/health");
      $("#health").textContent = "●";
    } catch (e) {
      $("#health").classList.add("bad");
    }
    await refreshPool();
    await refreshGroups();
    await refreshConversations();
    bindUi();
  }

  function renderUserBadge(me) {
    const el = document.getElementById("user-badge");
    if (!el) return;
    const label = me.name || me.email || me.id;
    el.innerHTML = "";
    const name = document.createElement("span");
    name.className = "user-name";
    name.textContent = label;
    el.appendChild(name);
    const out = document.createElement("a");
    out.href = "/auth/logout";
    out.className = "user-logout";
    out.textContent = "退出";
    el.appendChild(out);
    el.hidden = false;
  }


  function bindUi() {
    // Section title clicks → toggle collapse
    document.querySelectorAll(".section-title").forEach((el) => {
      el.addEventListener("click", () => toggleSection(el.dataset.toggle));
    });
    $("#btn-create-pool-agent").addEventListener("click", () => openCreateAgent(null));
    $("#btn-new-group").addEventListener("click", () => openNewGroupDialog());
    $("#btn-create-group").addEventListener("click", (ev) => { ev.preventDefault(); submitNewGroup(); });
    $("#btn-new-conv").addEventListener("click", () => openNewConvDialog());
    $("#btn-create-conv").addEventListener("click", (ev) => { ev.preventDefault(); submitNewConv(); });
    $("#btn-send").addEventListener("click", () => sendUserMessage());
    $("#btn-stop").addEventListener("click", () => stopActiveRound());
    $("#user-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendUserMessage();
    });
    $("#btn-poke").addEventListener("click", () => pokeActiveConv());
    $("#btn-pause").addEventListener("click", () => pauseActiveConv());
    $("#btn-resume").addEventListener("click", () => resumeActiveConv());
    $("#btn-finish").addEventListener("click", () => finishActiveConv());
    $("#btn-save-agent").addEventListener("click", (ev) => { ev.preventDefault(); saveAgentEdit(); });
    $("#btn-pick-confirm").addEventListener("click", (ev) => { ev.preventDefault(); confirmPickAgents(); });
    $("#btn-set-topic").addEventListener("click", () => submitNewTopic());
    $("#new-topic").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitNewTopic(); } });
    // Scroll-to-bottom floating button
    $("#scroll-bottom").addEventListener("click", () => { scrollEvents(true); });
    // Scroll listener to track sticky-bottom state
    $("#events").addEventListener("scroll", onEventsScroll, { passive: true });
  }

  async function refreshGroups() {
    state.groups = await api("GET", "/api/groups");
    const ul = $("#groups");
    ul.innerHTML = "";
    if (state.groups.length === 0) {
      ul.innerHTML = '<li><small>暂无群组，点击 + 新建</small></li>';
      $("#btn-new-conv").disabled = true;
      return;
    }
    for (const g of state.groups) {
      // Row for the group itself
      const row = document.createElement("li");
      row.className = "row";
      const expanded = state.expandedGroups.has(g.id);
      const caret = expanded ? "▼" : "▶";
      row.innerHTML = `<span class="row-label"><span class="caret">${caret}</span>${escapeHtml(g.name)}</span>`;
      if (state.activeGroup && state.activeGroup.id === g.id) row.classList.add("active");
      row.addEventListener("click", async () => {
        // Toggle expansion + select
        if (expanded) {
          state.expandedGroups.delete(g.id);
        } else {
          state.expandedGroups.add(g.id);
          await loadGroupAgents(g.id);
        }
        await selectGroup(g);
      });
      ul.appendChild(row);

      // Inline sub-list of agents (only when expanded)
      if (expanded) {
        const sub = document.createElement("ul");
        sub.className = "agent-sublist";
        const agents = state.groupAgents.get(g.id) || [];
        for (const a of agents) {
          const item = document.createElement("li");
          item.innerHTML = `
            <span class="name">${escapeHtml(a.display_name)}</span>
            <span class="preview" title="${escapeHtml(a.persona)}">${escapeHtml(truncate(a.persona, 50))}</span>
            <span class="version">v${a.version}</span>
            <span class="row-actions">
              <button class="btn-remove" title="从本讨论组移除（智能体仍在池中保留）">移出</button>
            </span>
          `;
          item.addEventListener("click", (ev) => {
            if (ev.target && (ev.target).closest(".btn-remove")) return;
            openEditAgent(g.id, a);
          });
          item.querySelector(".btn-remove").addEventListener("click", async (ev) => {
            ev.stopPropagation();
            if (!confirm(`将 "${a.display_name}" 从讨论组 "${g.name}" 移除？智能体本身仍保留在智能体池中，可在其他组使用。`)) return;
            await api("DELETE", `/api/groups/${g.id}/agents/${a.id}`);
            await loadGroupAgents(g.id);
            await refreshGroups();
          });
          sub.appendChild(item);
        }
        // Two add options
        const addExisting = document.createElement("li");
        addExisting.className = "add-row";
        addExisting.innerHTML = `<span>+ 添加现有智能体</span>`;
        addExisting.addEventListener("click", () => openPickAgents(g));
        sub.appendChild(addExisting);

        const addNew = document.createElement("li");
        addNew.className = "add-row";
        addNew.innerHTML = `<span>+ 创建智能体（同时加入本组与池）</span>`;
        addNew.addEventListener("click", () => openCreateAgent(g.id));
        sub.appendChild(addNew);

        ul.appendChild(sub);
      }
    }
  }

  async function loadGroupAgents(groupId) {
    const g = await api("GET", `/api/groups/${groupId}`);
    state.groupAgents.set(groupId, g.agents || []);
  }

  // -------- agent pool --------
  async function refreshPool() {
    state.poolAgents = await api("GET", "/api/agents");
    renderPool();
  }

  function toggleSection(name) {
    state.sectionCollapsed[name] = !state.sectionCollapsed[name];
    const section = document.querySelector(`.nav-section[data-section="${name}"]`);
    if (!section) return;
    section.classList.toggle("collapsed", state.sectionCollapsed[name]);
  }

  function renderPool() {
    const ul = $("#pool-agents");
    ul.innerHTML = "";
    for (const a of state.poolAgents) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="name-line">
          <span class="name">${escapeHtml(a.display_name)}</span>
          <span class="version">v${a.version}</span>
        </div>
        <div class="preview" title="${escapeHtml(a.persona)}">${escapeHtml(truncate(a.persona, 80))}</div>
        <span class="row-actions">
          <button class="btn-del">删</button>
        </span>
      `;
      li.addEventListener("click", (ev) => {
        if (ev.target && ev.target.closest(".btn-del")) return;
        openEditAgent(null, a);
      });
      li.querySelector(".btn-del").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm(`软删除智能体 "${a.display_name}"？已运行的会话不受影响；该智能体也会从所有讨论组的成员列表中失效。`)) return;
        await api("DELETE", `/api/agents/${a.id}`);
        await refreshPool();
        await refreshGroups();
      });
      ul.appendChild(li);
    }
  }

  async function selectGroup(g) {
    state.activeGroup = g;
    await refreshGroups();
    $("#btn-new-conv").disabled = false;
  }

  async function openNewGroupDialog() {
    $("#g-name").value = "产品评审组";
    $("#g-desc").value = "围绕一个产品方案展开多角度评审";
    await refreshPool();
    const box = $("#g-agents-list");
    box.innerHTML = "";
    if (state.poolAgents.length === 0) {
      box.innerHTML = '<div class="hint">智能体池为空。请先在左侧"智能体池"区域创建至少 2 个智能体，再来创建讨论组。</div>';
    } else {
      for (const a of state.poolAgents) {
        const row = document.createElement("div");
        row.className = "participant-check";
        const id = "ng_" + a.id;
        row.innerHTML = `<input type="checkbox" id="${id}" value="${a.id}" />
          <label for="${id}"><b>${escapeHtml(a.display_name)}</b> — ${escapeHtml(truncate(a.persona, 80))}</label>`;
        box.appendChild(row);
      }
    }
    $("#dlg-new-group").showModal();
  }

  async function submitNewGroup() {
    const name = $("#g-name").value.trim();
    const desc = $("#g-desc").value.trim();
    const ids = $$("#g-agents-list input:checked").map((el) => el.value);
    if (!name) { alert("请填写名称"); return; }
    if (ids.length < 2) { alert("请至少选择 2 个智能体"); return; }
    try {
      const g = await api("POST", "/api/groups", { name, description: desc });
      for (const aid of ids) {
        await api("POST", `/api/groups/${g.id}/members`, { agent_id: aid });
      }
      $("#dlg-new-group").close();
      await refreshGroups();
      selectGroup(g);
    } catch (e) {
      alert("创建失败: " + e.message);
    }
  }

  async function refreshConversations() {
    state.conversations = await api("GET", "/api/conversations");
    const ul = $("#conversations");
    ul.innerHTML = "";
    if (state.conversations.length === 0) {
      ul.innerHTML = '<li><small>暂无会话</small></li>';
      return;
    }
    for (const c of state.conversations) {
      const li = document.createElement("li");
      li.className = "row";
      const statusBadge = `<span class="badge-status ${escapeHtml(c.status)}">${escapeHtml(statusLabel(c.status))}</span>`;
      li.innerHTML = `<span class="row-label" title="${escapeHtml(c.topic)}">${escapeHtml(truncate(c.topic, 26))}</span>${statusBadge}`;
      li.addEventListener("click", () => selectConversation(c.id));
      if (state.activeConv && state.activeConv.id === c.id) li.classList.add("active");
      ul.appendChild(li);
    }
  }

  function statusLabel(status) {
    switch (status) {
      case "running": return "运行中";
      case "paused":  return "已暂停";
      case "finished": return "已结束";
      case "pending": return "待启动";
      default: return status;
    }
  }

  async function openNewConvDialog() {
    if (!state.activeGroup) return;
    const g = await api("GET", `/api/groups/${state.activeGroup.id}`);
    $("#c-group-name").textContent = g.name;
    $("#c-topic").value = "";
    const box = $("#c-participants");
    box.innerHTML = "";
    if (g.agents.length < 2) {
      box.innerHTML = '<p style="color:#e26464">此群组智能体不足 2 个</p>';
    }
    for (const a of g.agents) {
      const id = "p_" + a.id;
      const row = document.createElement("div");
      row.className = "participant-check";
      row.innerHTML = `<input type="checkbox" id="${id}" value="${a.id}" checked />
        <label for="${id}"><b>${escapeHtml(a.display_name)}</b> — ${escapeHtml(truncate(a.persona, 60))}</label>`;
      box.appendChild(row);
    }
    $("#dlg-new-conv").showModal();
  }

  async function submitNewConv() {
    const topic = $("#c-topic").value.trim();
    if (!topic) { alert("话题不能为空"); return; }
    const ids = $$("#c-participants input:checked").map((el) => el.value);
    if (ids.length < 2) { alert("至少选择 2 个智能体"); return; }
    try {
      const result = await api("POST", "/api/conversations", {
        group_id: state.activeGroup.id,
        topic,
        participant_def_ids: ids,
      });
      $("#dlg-new-conv").close();
      await refreshConversations();
      selectConversation(result.conversation.id);
    } catch (e) {
      alert("启动失败: " + e.message);
    }
  }

  async function selectConversation(id) {
    if (state.sse) { state.sse.close(); state.sse = null; }
    if (state.headerRefreshTimer) { clearInterval(state.headerRefreshTimer); state.headerRefreshTimer = null; }
    const c = await api("GET", `/api/conversations/${id}`);
    state.activeConv = c;
    state.participants = c.participants;
    state.roundActive = !!c.round_active;
    state.stickyBottom = true;
    state.pendingNewCount = 0;
    updateScrollPill();
    updateRoundButtons();
    $("#empty-state").classList.add("hidden");
    $("#conv-view").classList.remove("hidden");
    $("#conv-topic").textContent = c.topic;
    renderMeta(c);
    renderParticipants(c.participants);
    renderAddressSelect(c.participants);
    $("#btn-pause").classList.toggle("hidden", c.status !== "running");
    $("#btn-resume").classList.toggle("hidden", c.status === "running");
    $("#events").innerHTML = "";
    refreshConversations();
    connectStream(id);
    // Low-frequency background stats refresh (in-place, no DOM rebuild)
    state.headerRefreshTimer = setInterval(() => silentRefreshStats(), 30_000);
  }

  function renderMeta(c) {
    const totalIn = c.participants.reduce((s, p) => s + p.tokens_in, 0);
    const totalOut = c.participants.reduce((s, p) => s + p.tokens_out, 0);
    const cacheRead = c.participants.reduce((s, p) => s + p.cache_read, 0);
    $("#conv-meta").textContent =
      `状态: ${statusLabel(c.status)} · 成员 ${c.participants.length} · 输入 token ${totalIn} · 输出 token ${totalOut} · 命中缓存 ${cacheRead}`;
  }

  function renderParticipants(parts) {
    const box = $("#participants");
    // Reconcile in-place to avoid DOM nuke flicker. Same agent id keeps its element.
    const existing = new Map();
    box.querySelectorAll(".participant").forEach((el) => existing.set(el.dataset.id, el));
    const seen = new Set();
    for (const p of parts) {
      seen.add(p.id);
      let el = existing.get(p.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "participant";
        el.dataset.id = p.id;
        el.innerHTML = `<span class="name"></span><span class="stats"></span>`;
        box.appendChild(el);
      }
      el.querySelector(".name").textContent = p.name;
      el.querySelector(".stats").textContent =
        ` · 输入 ${p.tokens_in} · 输出 ${p.tokens_out} · 缓存 ${p.cache_read} · 摘要 ${p.digest_segments}`;
    }
    // Remove participants no longer present
    for (const [id, el] of existing) {
      if (!seen.has(id)) el.remove();
    }
  }

  function renderAddressSelect(parts) {
    const sel = $("#address-select");
    sel.innerHTML = '<option value="">— 不 @ 任何人 —</option>';
    for (const p of parts) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `@ ${p.name}`;
      sel.appendChild(opt);
    }
  }

  function connectStream(convId) {
    const es = new EventSource(`/api/conversations/${convId}/events`);
    state.sse = es;
    es.addEventListener("event", (ev) => {
      const e = JSON.parse(ev.data);
      appendEvent(e);
    });
    es.addEventListener("history_end", () => { scrollEvents(false); });
    es.onerror = () => { /* browser will retry */ };
  }

  // Buffer for the most recent round_start divider — rendered lazily only
  // when the first speech of that round actually arrives. If the round ends
  // with no speeches (or is aborted before any speech), the buffer is
  // discarded and only the round_end marker is shown.
  let pendingRoundStartEvent = null;

  function appendEvent(e) {
    // Defensive: silences are private; if one ever leaks through, drop it.
    if (e.kind === "silence" || e.visibility === "self_only") return;
    // Historic "stalled" markers are no longer emitted; hide any that exist in
    // the DB from previous buggy runs.
    if (e.kind === "topic_stalled") return;

    // Round lifecycle markers also drive the send/stop button toggle.
    if (e.kind === "round_start") {
      state.roundActive = true;
      updateRoundButtons();
      // Defer rendering — only show "Round N" divider when somebody actually speaks.
      pendingRoundStartEvent = e;
      return;
    }
    if (e.kind === "round_end") {
      state.roundActive = false;
      updateRoundButtons();
      const wasUnused = pendingRoundStartEvent !== null;
      pendingRoundStartEvent = null;
      const isNoone = e.content && e.content.includes("无人回应");
      const isAborted = e.content && e.content.includes("强制停止");
      // Only render the end marker when it carries info you can't infer from
      // the message bubbles themselves: nobody spoke, or it was force-stopped.
      // "X 人发言" success case is suppressed.
      if (!isNoone && !isAborted) return;
      // Aborted but at least one speech happened? Still useful to show.
      // Aborted with zero speeches before abort? Round-start was buffered &
      // discarded; we still render this end marker so user knows the round
      // was attempted and stopped.
      void wasUnused;
    }

    // Speech / user message arriving: flush any pending round-start divider first.
    if ((e.kind === "speech" || e.kind === "user_message") && pendingRoundStartEvent) {
      renderDividerBubble(pendingRoundStartEvent);
      pendingRoundStartEvent = null;
    }

    renderEventBubble(e);
  }

  function renderDividerBubble(e) {
    const div = document.createElement("div");
    div.className = `event kind-${e.kind} from-${e.speaker.kind}`;
    div.innerHTML = `<div class="content">${escapeHtml(e.content)}</div>`;
    $("#events").appendChild(div);
    if (state.stickyBottom) scrollEvents(false);
  }

  function renderEventBubble(e) {
    const div = document.createElement("div");
    div.className = `event kind-${e.kind} from-${e.speaker.kind}`;
    if (e.kind === "topic") {
      div.innerHTML = `<div class="content">📌 话题：${escapeHtml(e.content)}</div>`;
    } else if (e.kind === "system_note") {
      div.innerHTML = `<div class="content">⚠ ${escapeHtml(e.content)}</div>`;
    } else if (e.kind === "round_start") {
      div.innerHTML = `<div class="content">${escapeHtml(e.content)}</div>`;
    } else if (e.kind === "round_end") {
      if (e.content && e.content.includes("无人回应")) {
        div.classList.add("idle-result");
      }
      div.innerHTML = `<div class="content">${escapeHtml(e.content)}</div>`;
    } else {
      const addrStr = (e.address && e.address.length > 0)
        ? `<span class="addr">@ ${e.address.map(addrToName).join(", ")}</span>` : "";
      const who = `<div class="who"><b>${escapeHtml(e.speaker.display_name)}</b>${addrStr}</div>`;
      div.innerHTML = `${who}<div class="content">${escapeHtml(e.content)}</div>`;
    }
    $("#events").appendChild(div);
    // Auto-scroll only when user is at the bottom; otherwise show pill.
    if (state.stickyBottom) {
      scrollEvents(false);
    } else if (e.kind !== "topic" && e.kind !== "system_note" && e.kind !== "topic_stalled" && e.kind !== "round_start" && e.kind !== "round_end") {
      state.pendingNewCount += 1;
      updateScrollPill();
    }
  }

  function updateRoundButtons() {
    const sendBtn = $("#btn-send");
    const stopBtn = $("#btn-stop");
    if (state.roundActive) {
      sendBtn.disabled = true;
      sendBtn.title = "本轮讨论进行中，请等待全部智能体完成或点击「停止本轮」";
      stopBtn.classList.remove("hidden");
    } else {
      sendBtn.disabled = false;
      sendBtn.title = "";
      stopBtn.classList.add("hidden");
    }
  }

  async function stopActiveRound() {
    if (!state.activeConv) return;
    try {
      await api("POST", `/api/conversations/${state.activeConv.id}/stop`);
    } catch (e) {
      alert("停止失败: " + e.message);
    }
  }

  function onEventsScroll() {
    const box = $("#events");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom && !state.stickyBottom) {
      state.stickyBottom = true;
      state.pendingNewCount = 0;
      updateScrollPill();
    } else if (!atBottom && state.stickyBottom) {
      state.stickyBottom = false;
      updateScrollPill();
    }
  }

  function scrollEvents(smooth) {
    const box = $("#events");
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    state.stickyBottom = true;
    state.pendingNewCount = 0;
    updateScrollPill();
  }

  function updateScrollPill() {
    const btn = $("#scroll-bottom");
    const cnt = $("#scroll-bottom-count");
    if (!btn) return;
    if (state.stickyBottom) {
      btn.classList.add("hidden");
    } else {
      btn.classList.remove("hidden");
      if (state.pendingNewCount > 0) {
        cnt.textContent = String(state.pendingNewCount);
        cnt.classList.remove("hidden");
      } else {
        cnt.classList.add("hidden");
      }
    }
  }

  function addrToName(id) {
    const p = state.participants.find((x) => x.id === id);
    return p ? p.name : id;
  }

  /** Low-frequency, in-place stats refresh. Does NOT rebuild DOM. */
  async function silentRefreshStats() {
    if (!state.activeConv) return;
    try {
      const c = await api("GET", `/api/conversations/${state.activeConv.id}`);
      state.activeConv = c;
      state.participants = c.participants;
      renderMeta(c);
      renderParticipants(c.participants);   // reconciling, no flicker
    } catch {}
  }

  async function sendUserMessage() {
    if (!state.activeConv) return;
    const content = $("#user-input").value.trim();
    if (!content) return;
    const addrId = $("#address-select").value;
    const address = addrId ? [addrId] : [];
    try {
      await api("POST", `/api/conversations/${state.activeConv.id}/messages`, {
        content, user_name: "我", user_id: "user_local", address,
      });
      $("#user-input").value = "";
    } catch (e) {
      alert("发送失败: " + e.message);
    }
  }

  async function pokeActiveConv() {
    if (!state.activeConv) return;
    try { await api("POST", `/api/conversations/${state.activeConv.id}/poke`); }
    catch (e) { alert(e.message); }
  }
  async function pauseActiveConv() {
    if (!state.activeConv) return;
    try {
      await api("POST", `/api/conversations/${state.activeConv.id}/pause`);
      await selectConversation(state.activeConv.id);
    } catch (e) { alert(e.message); }
  }
  async function resumeActiveConv() {
    if (!state.activeConv) return;
    try {
      await api("POST", `/api/conversations/${state.activeConv.id}/resume`);
      await selectConversation(state.activeConv.id);
    } catch (e) { alert(e.message); }
  }
  async function finishActiveConv() {
    if (!state.activeConv) return;
    if (!confirm("结束该会话？")) return;
    try {
      await api("POST", `/api/conversations/${state.activeConv.id}/finish`);
      await selectConversation(state.activeConv.id);
      await refreshConversations();
    } catch (e) { alert(e.message); }
  }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function truncate(s, n) {
    s = (s ?? "").toString();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // -------- new topic injection --------
  async function submitNewTopic() {
    if (!state.activeConv) return;
    const t = $("#new-topic").value.trim();
    if (!t) return;
    try {
      await api("POST", `/api/conversations/${state.activeConv.id}/topic`, { topic: t });
      $("#new-topic").value = "";
    } catch (e) {
      alert("提出失败: " + e.message);
    }
  }

  // -------- agent management (inline-expansion-driven) --------
  // editingAgent: { mode: "create" | "edit", groupId: string|null, agentId? }
  let editingAgent = null;

  function openCreateAgent(groupId) {
    editingAgent = { mode: "create", groupId };
    const title = groupId
      ? "创建智能体（保存后将加入当前讨论组，并保留在智能体池）"
      : "创建智能体（仅入池，可后续添加到讨论组）";
    $("#dlg-edit-agent").querySelector("h3").textContent = title;
    $("#e-name").value = "";
    $("#e-persona").value = "";
    $("#e-provider").value = "deepseek:deepseek-v4-pro";
    $("#e-temp").value = 0.7;
    $("#e-maxout").value = 600;
    $("#e-talk").value = "balanced";
    $("#e-silent").value = 3;
    $("#dlg-edit-agent").showModal();
    $("#e-name").focus();
  }

  function openEditAgent(groupId, a) {
    editingAgent = { mode: "edit", groupId, agentId: a.id };
    $("#dlg-edit-agent").querySelector("h3").textContent = `编辑智能体 — ${a.display_name}`;
    $("#e-name").value = a.display_name;
    $("#e-persona").value = a.persona;
    $("#e-provider").value = a.provider_binding;
    $("#e-temp").value = a.model_params?.temperature ?? 0.7;
    $("#e-maxout").value = a.model_params?.max_output_tokens ?? 600;
    $("#e-talk").value = a.speaking_policy?.talkativeness_hint ?? "balanced";
    $("#e-silent").value = a.speaking_policy?.silent_streak_threshold ?? 3;
    $("#dlg-edit-agent").showModal();
  }

  async function saveAgentEdit() {
    if (!editingAgent) return;
    const payload = {
      display_name: $("#e-name").value.trim(),
      persona: $("#e-persona").value.trim(),
      provider_binding: $("#e-provider").value.trim() || "deepseek:deepseek-v4-pro",
      model_params: {
        temperature: parseFloat($("#e-temp").value) || 0.7,
        max_output_tokens: parseInt($("#e-maxout").value, 10) || 600,
      },
      speaking_policy: {
        cooldown_turns: 0,  // inert under round-based model; kept for backward-compat schema
        talkativeness_hint: $("#e-talk").value.trim() || "balanced",
        wake_on: ["*"],
        silent_streak_threshold: parseInt($("#e-silent").value, 10) || 3,
      },
    };
    if (!payload.display_name || !payload.persona) {
      alert("名字和人设不能为空"); return;
    }
    try {
      const { mode, groupId, agentId } = editingAgent;
      if (mode === "create") {
        if (groupId) {
          // creates in pool + auto-membership via /groups/:gid/agents endpoint
          await api("POST", `/api/groups/${groupId}/agents`, payload);
        } else {
          // pool-only create
          await api("POST", `/api/agents`, payload);
        }
      } else {
        // edit affects pool entity (all groups share it)
        await api("PATCH", `/api/agents/${agentId}`, payload);
      }
      editingAgent = null;
      $("#dlg-edit-agent").close();
      await refreshPool();
      if (groupId) await loadGroupAgents(groupId);
      await refreshGroups();
    } catch (e) {
      alert("保存失败: " + e.message);
    }
  }

  // -------- agent picker (add existing pool agents to a group) --------
  let pickerGroup = null;
  async function openPickAgents(group) {
    pickerGroup = group;
    await refreshPool();
    const members = state.groupAgents.get(group.id) || [];
    const memberIds = new Set(members.map((m) => m.id));
    $("#pk-group-name").textContent = group.name;
    const box = $("#pk-list");
    box.innerHTML = "";
    const candidates = state.poolAgents.filter((a) => !memberIds.has(a.id));
    if (candidates.length === 0) {
      box.innerHTML = '<div class="hint">智能体池中没有更多可添加的智能体。可点击下面"创建智能体"先入池。</div>';
    } else {
      for (const a of candidates) {
        const row = document.createElement("div");
        row.className = "participant-check";
        const id = "pk_" + a.id;
        row.innerHTML = `<input type="checkbox" id="${id}" value="${a.id}" />
          <label for="${id}"><b>${escapeHtml(a.display_name)}</b> — ${escapeHtml(truncate(a.persona, 80))}</label>`;
        box.appendChild(row);
      }
    }
    $("#dlg-pick-agents").showModal();
  }

  async function confirmPickAgents() {
    if (!pickerGroup) return;
    const ids = $$("#pk-list input:checked").map((el) => el.value);
    if (ids.length === 0) { $("#dlg-pick-agents").close(); return; }
    try {
      for (const aid of ids) {
        await api("POST", `/api/groups/${pickerGroup.id}/members`, { agent_id: aid });
      }
      const gid = pickerGroup.id;
      pickerGroup = null;
      $("#dlg-pick-agents").close();
      await loadGroupAgents(gid);
      await refreshGroups();
    } catch (e) {
      alert("添加失败: " + e.message);
    }
  }

  init();
})();
