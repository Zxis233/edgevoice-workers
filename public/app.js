const elements = {
  displayNameInput: document.querySelector("#displayNameInput"),
  roomTitleInput: document.querySelector("#roomTitleInput"),
  roomIdInput: document.querySelector("#roomIdInput"),
  createButton: document.querySelector("#createButton"),
  joinButton: document.querySelector("#joinButton"),
  leaveButton: document.querySelector("#leaveButton"),
  muteButton: document.querySelector("#muteButton"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  appStatus: document.querySelector("#appStatus"),
  roomPanel: document.querySelector("#roomPanel"),
  roomName: document.querySelector("#roomName"),
  roomMeta: document.querySelector("#roomMeta"),
  participantCount: document.querySelector("#participantCount"),
  participantGrid: document.querySelector("#participantGrid"),
  remoteAudioBin: document.querySelector("#remoteAudioBin")
};

const state = {
  roomId: new URL(window.location.href).searchParams.get("room") ?? "",
  roomMeta: null,
  ws: null,
  localStream: null,
  iceServers: [],
  selfPeerId: null,
  displayName: "",
  participants: new Map(),
  peerConnections: new Map(),
  audioElements: new Map(),
  audioContext: null,
  speakingTimer: null,
  heartbeatTimer: null,
  isMuted: false,
  isLeaving: false
};

function setStatus(message, tone = "neutral") {
  elements.appStatus.textContent = message;
  elements.appStatus.className = `status status--${tone}`;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `请求失败 (${response.status})`);
  }

  return data;
}

function getLegacyGetUserMedia() {
  return (
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia ||
    navigator.msGetUserMedia
  );
}

async function requestUserMedia(constraints) {
  if (navigator.mediaDevices?.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  const legacyGetUserMedia = getLegacyGetUserMedia();
  if (!legacyGetUserMedia) {
    if (!window.isSecureContext) {
      throw new Error("当前页面不是 HTTPS 或 localhost，移动端浏览器不会开放麦克风接口。");
    }

    throw new Error("当前浏览器不支持麦克风采集接口。");
  }

  return new Promise((resolve, reject) => {
    legacyGetUserMedia.call(navigator, constraints, resolve, reject);
  });
}

async function getLocalAudioStream() {
  const preferredConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  };

  try {
    return await requestUserMedia(preferredConstraints);
  } catch (error) {
    if (error?.name === "OverconstrainedError" || error?.name === "TypeError") {
      return requestUserMedia({ audio: true, video: false });
    }

    throw error;
  }
}

function describeMediaError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "浏览器拒绝了麦克风权限，请检查权限设置并确认页面使用 HTTPS 或 localhost。";
    case "NotFoundError":
      return "没有找到可用的麦克风设备。";
    case "NotReadableError":
      return "麦克风正在被其他应用占用，或系统暂时无法读取。";
    case "OverconstrainedError":
      return "当前设备不支持请求的音频约束，建议重试。";
    default:
      return "无法获取麦克风，请确认你正在用 HTTPS 或 localhost 打开页面。";
  }
}

function roomInviteUrl(roomId = state.roomId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("room", roomId);
  return url.toString();
}

function websocketUrl(roomId, displayName, peerId) {
  const url = new URL(`/api/rooms/${roomId}/ws`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("name", displayName);
  url.searchParams.set("peerId", peerId);
  return url.toString();
}

function setQueryRoom(roomId) {
  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set("room", roomId);
  } else {
    url.searchParams.delete("room");
  }

  window.history.replaceState({}, "", url);
}

function normalizeRoomId(value) {
  return `${value ?? ""}`.trim();
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ensureDisplayName() {
  const displayName = `${elements.displayNameInput.value ?? ""}`.trim();
  if (!displayName) {
    throw new Error("请先输入昵称。");
  }

  return displayName.slice(0, 32);
}

function updateButtons() {
  const connected = Boolean(state.localStream);
  elements.muteButton.disabled = !connected;
  elements.leaveButton.disabled = !connected;
  elements.copyLinkButton.disabled = !state.roomId;
  elements.muteButton.textContent = state.isMuted ? "取消静音" : "静音麦克风";
}

function participantList() {
  return Array.from(state.participants.values()).sort((left, right) => {
    if (left.peerId === state.selfPeerId) {
      return -1;
    }

    if (right.peerId === state.selfPeerId) {
      return 1;
    }

    return `${left.joinedAt ?? ""}`.localeCompare(`${right.joinedAt ?? ""}`);
  });
}

function renderParticipants() {
  const list = participantList();
  const capacity = state.roomMeta?.capacity ?? 5;
  elements.participantCount.textContent = `${list.length} / ${capacity}`;

  if (list.length === 0) {
    elements.participantGrid.innerHTML = '<div class="participant-empty">加入房间后会在这里显示参与者、静音状态和连接状态。</div>';
    return;
  }

  elements.participantGrid.innerHTML = list
    .map((participant) => {
      const badges = [];
      badges.push(
        `<span class="badge badge--slate">${escapeHtml(participant.statusLabel ?? participant.status ?? "等待连接")}</span>`
      );

      if (participant.peerId === state.selfPeerId) {
        badges.push('<span class="badge badge--warm">我自己</span>');
      }

      if (participant.muted) {
        badges.push('<span class="badge badge--warm">已静音</span>');
      }

      if (participant.speaking) {
        badges.push('<span class="badge badge--teal">正在讲话</span>');
      }

      const cardClass = [
        "participant-card",
        participant.peerId === state.selfPeerId ? "participant-card--self" : "",
        participant.speaking ? "participant-card--speaking" : ""
      ]
        .filter(Boolean)
        .join(" ");

      return `
        <article class="${cardClass}">
          <h3 class="participant-card__name">${escapeHtml(participant.displayName || participant.peerId)}</h3>
          <p class="participant-card__meta">Peer ID: ${escapeHtml(participant.peerId)}</p>
          <p class="participant-card__status">${escapeHtml(participant.note ?? "音频已就绪后会自动播放。")}</p>
          <div class="badge-row">${badges.join("")}</div>
        </article>
      `;
    })
    .join("");
}

function renderRoomMeta() {
  const roomVisible = Boolean(state.roomId || state.roomMeta);
  elements.roomPanel.hidden = !roomVisible;

  if (!roomVisible) {
    return;
  }

  elements.roomName.textContent = state.roomMeta?.title ?? state.roomId ?? "未加入房间";
  const roomId = state.roomMeta?.id ?? state.roomId;
  const joinLink = roomId ? roomInviteUrl(roomId) : "";
  elements.roomMeta.textContent = roomId
    ? `房间 ID：${roomId} · 邀请链接：${joinLink}`
    : "创建或加入房间后，这里会显示房间信息。";
}

function upsertParticipant(peer) {
  const current = state.participants.get(peer.peerId) ?? {};
  state.participants.set(peer.peerId, {
    ...current,
    ...peer
  });
  renderParticipants();
}

function removeParticipant(peerId) {
  state.participants.delete(peerId);
  renderParticipants();
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = window.setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, 20000);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    window.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function stopSpeakingMonitor() {
  if (state.speakingTimer) {
    window.clearInterval(state.speakingTimer);
    state.speakingTimer = null;
  }

  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }
}

function startSpeakingMonitor(stream) {
  stopSpeakingMonitor();

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  const context = new AudioContextCtor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const bucket = new Uint8Array(analyser.frequencyBinCount);
  let lastSpeaking = false;

  state.audioContext = context;
  state.speakingTimer = window.setInterval(() => {
    analyser.getByteTimeDomainData(bucket);

    let sum = 0;
    for (const value of bucket) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }

    const rms = Math.sqrt(sum / bucket.length);
    const speaking = !state.isMuted && rms > 0.05;

    if (speaking !== lastSpeaking) {
      lastSpeaking = speaking;
      upsertParticipant({
        peerId: state.selfPeerId,
        speaking,
        statusLabel: state.isMuted ? "本地静音" : "本地麦克风在线"
      });
      sendMessage({ type: "peer-state", muted: state.isMuted, speaking });
    }
  }, 280);
}

function closePeerConnection(peerId) {
  const connection = state.peerConnections.get(peerId);
  if (connection) {
    connection.pc.close();
    state.peerConnections.delete(peerId);
  }

  const audioElement = state.audioElements.get(peerId);
  if (audioElement) {
    audioElement.remove();
    state.audioElements.delete(peerId);
  }
}

function resetSession({ preserveRoom = true } = {}) {
  stopHeartbeat();
  stopSpeakingMonitor();

  for (const peerId of state.peerConnections.keys()) {
    closePeerConnection(peerId);
  }

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      track.stop();
    }
  }

  const activeSocket = state.ws;
  state.ws = null;

  if (activeSocket) {
    try {
      activeSocket.close();
    } catch {
      // noop
    }
  }
  state.localStream = null;
  state.iceServers = [];
  state.selfPeerId = null;
  state.displayName = "";
  state.participants.clear();
  state.isMuted = false;

  if (!preserveRoom) {
    state.roomId = "";
    state.roomMeta = null;
    elements.roomIdInput.value = "";
    setQueryRoom("");
  }

  updateButtons();
  renderParticipants();
  renderRoomMeta();
}

function sendMessage(payload) {
  if (state.ws?.readyState !== WebSocket.OPEN) {
    return;
  }

  state.ws.send(JSON.stringify(payload));
}

function attachRemoteStream(peerId, stream) {
  let audioElement = state.audioElements.get(peerId);
  if (!audioElement) {
    audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.playsInline = true;
    elements.remoteAudioBin.append(audioElement);
    state.audioElements.set(peerId, audioElement);
  }

  audioElement.srcObject = stream;
  audioElement.play().catch(() => {});

  upsertParticipant({
    peerId,
    status: "connected",
    statusLabel: "音频已连接",
    note: "远端音频正在播放。"
  });
}

function ensurePeerConnection(peerId) {
  const existing = state.peerConnections.get(peerId);
  if (existing) {
    return existing;
  }

  const connection = {
    pc: new RTCPeerConnection({
      iceServers: state.iceServers,
      bundlePolicy: "max-bundle"
    }),
    pendingCandidates: [],
    remoteDescriptionReady: false
  };

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      connection.pc.addTrack(track, state.localStream);
    }
  }

  connection.pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      return;
    }

    sendMessage({
      type: "signal",
      targetPeerId: peerId,
      signalKind: "ice-candidate",
      candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate
    });
  });

  connection.pc.addEventListener("track", (event) => {
    const [stream] = event.streams;
    attachRemoteStream(peerId, stream ?? new MediaStream([event.track]));
  });

  connection.pc.addEventListener("connectionstatechange", () => {
    const current = state.peerConnections.get(peerId);
    if (!current) {
      return;
    }

    const stateLabelMap = {
      new: "等待协商",
      connecting: "建立连接中",
      connected: "音频已连接",
      disconnected: "连接中断",
      failed: "连接失败",
      closed: "连接已关闭"
    };

    upsertParticipant({
      peerId,
      status: connection.pc.connectionState,
      statusLabel: stateLabelMap[connection.pc.connectionState] ?? "等待协商",
      note:
        connection.pc.connectionState === "connected"
          ? "远端音频正在播放。"
          : "WebRTC 正在同步音频轨道。"
    });
  });

  state.peerConnections.set(peerId, connection);
  return connection;
}

async function flushPendingCandidates(peerId) {
  const connection = state.peerConnections.get(peerId);
  if (!connection || !connection.remoteDescriptionReady) {
    return;
  }

  while (connection.pendingCandidates.length > 0) {
    const candidate = connection.pendingCandidates.shift();
    await connection.pc.addIceCandidate(candidate);
  }
}

async function createOfferForPeer(peerId) {
  const connection = ensurePeerConnection(peerId);
  if (connection.pc.signalingState !== "stable") {
    return;
  }

  const offer = await connection.pc.createOffer({ offerToReceiveAudio: true });
  await connection.pc.setLocalDescription(offer);

  sendMessage({
    type: "signal",
    targetPeerId: peerId,
    signalKind: "offer",
    sdp: connection.pc.localDescription?.sdp
  });
}

async function handleOffer(sourcePeerId, sdp) {
  const connection = ensurePeerConnection(sourcePeerId);
  await connection.pc.setRemoteDescription({ type: "offer", sdp });
  connection.remoteDescriptionReady = true;
  await flushPendingCandidates(sourcePeerId);

  const answer = await connection.pc.createAnswer();
  await connection.pc.setLocalDescription(answer);

  sendMessage({
    type: "signal",
    targetPeerId: sourcePeerId,
    signalKind: "answer",
    sdp: connection.pc.localDescription?.sdp
  });
}

async function handleAnswer(sourcePeerId, sdp) {
  const connection = ensurePeerConnection(sourcePeerId);
  await connection.pc.setRemoteDescription({ type: "answer", sdp });
  connection.remoteDescriptionReady = true;
  await flushPendingCandidates(sourcePeerId);
}

async function handleCandidate(sourcePeerId, candidate) {
  const connection = ensurePeerConnection(sourcePeerId);
  const iceCandidate = candidate ? new RTCIceCandidate(candidate) : null;

  if (!iceCandidate) {
    return;
  }

  if (!connection.remoteDescriptionReady) {
    connection.pendingCandidates.push(iceCandidate);
    return;
  }

  await connection.pc.addIceCandidate(iceCandidate);
}

async function handleSocketMessage(rawData) {
  const message = JSON.parse(rawData);

  if (message.type === "welcome") {
    state.roomId = message.roomId;
    state.roomMeta = {
      ...(state.roomMeta ?? {}),
      id: message.roomId,
      capacity: message.capacity,
      title: state.roomMeta?.title ?? message.roomId
    };

    upsertParticipant({
      ...message.self,
      status: "connected",
      statusLabel: "本地麦克风在线",
      note: "你已经加入房间。"
    });

    for (const peer of message.peers) {
      upsertParticipant({
        ...peer,
        status: "connecting",
        statusLabel: "等待协商",
        note: "对端已在房间内，准备建立音频连接。"
      });
    }

    for (const peer of message.peers) {
      await createOfferForPeer(peer.peerId);
    }

    startHeartbeat();
    setStatus(`已加入 ${state.roomMeta.title}。`, "success");
    renderRoomMeta();
    return;
  }

  if (message.type === "peer-joined") {
    upsertParticipant({
      ...message.peer,
      status: "connecting",
      statusLabel: "等待来电",
      note: "新成员已加入，等待对端发起协商。"
    });
    setStatus(`${message.peer.displayName} 已加入房间。`, "info");
    return;
  }

  if (message.type === "peer-updated") {
    upsertParticipant(message.peer);
    return;
  }

  if (message.type === "peer-left") {
    closePeerConnection(message.peerId);
    removeParticipant(message.peerId);
    setStatus(`成员 ${message.peerId} 已离开。`, "info");
    return;
  }

  if (message.type === "signal") {
    if (message.signalKind === "offer") {
      await handleOffer(message.sourcePeerId, message.sdp);
      return;
    }

    if (message.signalKind === "answer") {
      await handleAnswer(message.sourcePeerId, message.sdp);
      return;
    }

    if (message.signalKind === "ice-candidate") {
      await handleCandidate(message.sourcePeerId, message.candidate);
    }

    return;
  }

  if (message.type === "error") {
    setStatus(message.message || "信令错误。", "error");
  }
}

async function joinRoom(roomId) {
  const displayName = ensureDisplayName();
  const normalizedRoomId = normalizeRoomId(roomId || elements.roomIdInput.value);
  if (!normalizedRoomId) {
    throw new Error("请输入房间 ID。");
  }

  resetSession({ preserveRoom: true });
  setStatus("正在获取麦克风和房间配置...", "info");

  const [roomPayload, icePayload] = await Promise.all([
    fetchJson(`/api/rooms/${normalizedRoomId}`),
    fetchJson("/api/ice-servers")
  ]);

  if (roomPayload.room.activeCount >= roomPayload.room.capacity) {
    throw new Error("房间已满，请新建一个房间。");
  }

  let localStream;
  try {
    localStream = await getLocalAudioStream();
  } catch (error) {
    throw new Error(describeMediaError(error));
  }

  state.roomId = normalizedRoomId;
  state.roomMeta = roomPayload.room;
  state.iceServers = icePayload.iceServers;
  state.localStream = localStream;
  state.selfPeerId = crypto.randomUUID();
  state.displayName = displayName;
  state.isLeaving = false;
  state.isMuted = false;

  elements.roomIdInput.value = normalizedRoomId;
  setQueryRoom(normalizedRoomId);
  renderRoomMeta();
  updateButtons();
  startSpeakingMonitor(localStream);

  const socket = new WebSocket(websocketUrl(normalizedRoomId, displayName, state.selfPeerId));
  state.ws = socket;

  socket.addEventListener("open", () => {
    if (socket !== state.ws) {
      return;
    }

    setStatus("信令已连接，等待房间确认...", "info");
  });

  socket.addEventListener("message", async (event) => {
    if (socket !== state.ws) {
      return;
    }

    try {
      await handleSocketMessage(event.data);
    } catch (error) {
      setStatus(error.message || "处理信令消息失败。", "error");
    }
  });

  socket.addEventListener("close", () => {
    if (socket !== state.ws || state.isLeaving) {
      return;
    }

    setStatus("连接已断开，请重新加入房间。", "error");
    resetSession({ preserveRoom: true });
  });

  socket.addEventListener("error", () => {
    if (socket !== state.ws) {
      return;
    }

    setStatus("WebSocket 连接失败。", "error");
  });
}

async function createAndJoinRoom() {
  const displayName = ensureDisplayName();
  const title = `${elements.roomTitleInput.value ?? ""}`.trim() || "Quick Voice Room";

  const payload = await fetchJson("/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      title,
      capacity: 5
    })
  });

  elements.roomIdInput.value = payload.room.id;
  elements.roomTitleInput.value = payload.room.title;
  elements.displayNameInput.value = displayName;
  await joinRoom(payload.room.id);
}

async function leaveRoom() {
  state.isLeaving = true;
  sendMessage({ type: "leave" });
  resetSession({ preserveRoom: true });
  setStatus("已离开房间。", "info");
}

async function toggleMute() {
  if (!state.localStream) {
    return;
  }

  state.isMuted = !state.isMuted;
  for (const track of state.localStream.getAudioTracks()) {
    track.enabled = !state.isMuted;
  }

  upsertParticipant({
    peerId: state.selfPeerId,
    muted: state.isMuted,
    speaking: false,
    statusLabel: state.isMuted ? "本地静音" : "本地麦克风在线"
  });
  updateButtons();
  sendMessage({ type: "peer-state", muted: state.isMuted, speaking: false });
}

async function copyInviteLink() {
  if (!state.roomId) {
    return;
  }

  await navigator.clipboard.writeText(roomInviteUrl());
  setStatus("邀请链接已复制。", "success");
}

async function bootstrapRoomPreview() {
  if (!state.roomId) {
    updateButtons();
    renderRoomMeta();
    renderParticipants();
    return;
  }

  elements.roomIdInput.value = state.roomId;

  try {
    const payload = await fetchJson(`/api/rooms/${state.roomId}`);
    state.roomMeta = payload.room;
    renderRoomMeta();
    renderParticipants();
    updateButtons();
    setStatus(`已读取房间 ${payload.room.title}，输入昵称后即可加入。`, "info");
  } catch {
    setStatus("链接中的房间不存在，可以新建一个。", "error");
  }
}

elements.createButton.addEventListener("click", async () => {
  try {
    await createAndJoinRoom();
  } catch (error) {
    setStatus(error.message || "创建房间失败。", "error");
    resetSession({ preserveRoom: true });
  }
});

elements.joinButton.addEventListener("click", async () => {
  try {
    await joinRoom(elements.roomIdInput.value || state.roomId);
  } catch (error) {
    setStatus(error.message || "加入房间失败。", "error");
    resetSession({ preserveRoom: true });
  }
});

elements.leaveButton.addEventListener("click", async () => {
  await leaveRoom();
});

elements.muteButton.addEventListener("click", async () => {
  await toggleMute();
});

elements.copyLinkButton.addEventListener("click", async () => {
  try {
    await copyInviteLink();
  } catch {
    setStatus("复制失败，请手动复制地址栏链接。", "error");
  }
});

window.addEventListener("beforeunload", () => {
  state.isLeaving = true;
  sendMessage({ type: "leave" });
});

bootstrapRoomPreview();


