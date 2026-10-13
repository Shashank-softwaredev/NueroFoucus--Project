// One-to-one interview room. Media is live-only; room events are operational notes for HR.
const auth = requireAuth();
if (!auth) throw new Error("Sign in required");

const roomId = (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
if (!/^NF-[A-HJ-NP-Z2-9]{6}$/.test(roomId)) location.replace("/dashboard.html");

const $ = (id) => document.getElementById(id);
const labels = { coding: "Coding", aptitude: "Aptitude", company: "Company", behavioral: "Role & experience" };
let localStream = null;
let displayStream = null;
let screenSender = null;
let pc = null;
let ws = null;
let joined = false;
let left = false;
let peerPresent = false;
let makingOffer = false;
let remoteShareActive = false;
let remoteCameraEnabled = true;
let remoteMicrophoneMuted = false;
let microphoneEnabled = true;
let cameraEnabled = true;
let pendingIce = [];
let qualityTimer = null;
let reconnectTimer = null;
let previewTimer = null;
let localVideoTimer = null;
let lastConnectionState = "";
let events = [];
const questionCards = new Map();

setActiveNav();
$("room-pill").textContent = `Room ${roomId}`;
$("local-tag").textContent = auth.name;
$("local-avatar").textContent = auth.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
$("preview-name").textContent = `${auth.name} · Camera preview`;
$("camera-lock").hidden = false;
$("question-form").hidden = auth.role !== "hr";
$("tab-btn-log").hidden = auth.role !== "hr";
$("tab-log").hidden = auth.role !== "hr";
$("sidebar-caption").textContent = auth.role === "hr"
  ? "Questions, technical room events, and connection quality."
  : "Questions, answers, and a private chat with your interviewer.";
switchTab(auth.role === "hr" ? "log" : "questions");

function setPermissionStatus(text, kind = "") {
  const element = $("permission-status");
  element.textContent = text;
  element.className = `permission-status ${kind}`.trim();
}

function setJoinEnabled() {
  const preview = $("preview-video");
  const previewHasFrames = preview.videoWidth > 0 && preview.videoHeight > 0 && !preview.paused;
  const hasCamera = Boolean(previewHasFrames && localStream?.getVideoTracks().some((track) => track.readyState === "live" && !track.muted));
  const hasMicrophone = Boolean(localStream?.getAudioTracks().some((track) => track.readyState === "live"));
  $("join-room-btn").disabled = !(hasCamera && hasMicrophone && $("consent-check").checked);
}

function deviceOptions(select, devices, kind, selectedId) {
  const oldValue = selectedId || select.value;
  select.replaceChildren();
  const matching = devices.filter((device) => device.kind === kind);
  matching.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${index + 1}`;
    select.append(option);
  });
  if (oldValue && matching.some((device) => device.deviceId === oldValue)) select.value = oldValue;
}

async function refreshDeviceLists() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  deviceOptions($("camera-select"), devices, "videoinput", localStream?.getVideoTracks()[0]?.getSettings().deviceId);
  deviceOptions($("microphone-select"), devices, "audioinput", localStream?.getAudioTracks()[0]?.getSettings().deviceId);
}

async function validateRoom() {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/availability`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "This room isn’t available. Check the code with your interviewer.");
}

async function captureMedia(kind, deviceId) {
  if (!window.isSecureContext) throw new Error("Camera and microphone require HTTPS or localhost. Open this interview from a secure page.");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support camera and microphone capture.");
  const isVideo = kind === "video";
  const exact = deviceId ? { deviceId: { exact: deviceId } } : {};
  const ideal = isVideo
    ? { width: { ideal: 1280 }, height: { ideal: 720 } }
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const relaxed = isVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : { echoCancellation: true };
  const variants = [
    { [kind]: { ...exact, ...ideal } },
    ...(deviceId ? [{ [kind]: { ...ideal } }] : []),
    { [kind]: relaxed },
    { [kind]: true },
  ];
  let lastError;
  for (let index = 0; index < variants.length; index += 1) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: isVideo ? variants[index].video : false,
        audio: isVideo ? false : variants[index].audio,
      });
    } catch (error) {
      const failure = new Error(error.message);
      failure.name = error.name;
      failure.mediaKind = kind;
      lastError = failure;
      if (["NotAllowedError", "SecurityError"].includes(error.name)) throw failure;
    }
  }
  throw lastError;
}

function mediaErrorMessage(kind, error) {
  const mediaLabel = kind === "video" ? "camera" : "microphone";
  const details = {
    NotAllowedError: "Permission was denied. Allow access for this site in your browser settings.",
    NotFoundError: "No compatible device was found. Connect a camera or microphone and refresh the device list.",
    NotReadableError: "The device may be in use by another app or its driver may have timed out. Close other camera/audio apps and retry.",
    OverconstrainedError: "The selected device cannot meet the requested settings. Choose another device or retry.",
    SecurityError: "This page needs HTTPS or localhost and permission to use media devices.",
    AbortError: "The device start was interrupted. Wait a moment and retry.",
  };
  return `Could not start the ${mediaLabel}. ${details[error?.name] || error?.message || "Check the device and browser permission, then retry."}`;
}

async function acquireMedia() {
  if (!window.isSecureContext) throw new Error("Camera and microphone require HTTPS or localhost. Open this interview from a secure page.");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support camera and microphone capture.");
  const videoDevice = $("camera-select").value;
  const audioDevice = $("microphone-select").value;
  let videoStream;
  let audioStream;
  let videoError;
  let audioError;
  // Ask for both devices in one browser permission/capture transaction first.
  // A modest baseline is more compatible with integrated and older laptop cameras;
  // the selected-device and relaxed-constraint fallbacks below remain available.
  const videoConstraints = {
    ...(videoDevice ? { deviceId: { exact: videoDevice } } : {}),
    width: { ideal: 640 },
    height: { ideal: 480 },
  };
  const audioConstraints = {
    ...(audioDevice ? { deviceId: { exact: audioDevice } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  try {
    const combined = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
    videoStream = combined;
    audioStream = combined;
  } catch (error) {
    // Permission and secure-context failures should be surfaced immediately.
    // Other device/constraint failures can still leave one device usable, so
    // retry each independently using the existing compatibility ladder.
    if (error.name === "NotAllowedError") throw new Error("Camera or microphone permission was denied. Allow both for this site in browser settings, then refresh the device check.");
    if (error.name === "SecurityError") throw new Error("Camera and microphone require HTTPS or localhost. Open the interview from a secure page.");
    try { videoStream = await captureMedia("video", videoDevice); } catch (videoFailure) { videoError = videoFailure; }
    try { audioStream = await captureMedia("audio", audioDevice); } catch (audioFailure) { audioError = audioFailure; }
  }
  if (!videoStream && !audioStream) {
    throw new Error([videoError && mediaErrorMessage("video", videoError), audioError && mediaErrorMessage("audio", audioError)].filter(Boolean).join(" "));
  }

  const videoTracks = videoStream?.getVideoTracks() || [];
  const audioTracks = audioStream?.getAudioTracks() || [];
  const replacement = new MediaStream([...videoTracks, ...audioTracks]);
  const old = localStream;
  localStream = replacement;
  const preview = $("preview-video");
  preview.srcObject = videoTracks.length ? replacement : null;
  preview.muted = true;
  preview.playsInline = true;
  const deviceIssues = [videoError && mediaErrorMessage("video", videoError), audioError && mediaErrorMessage("audio", audioError)].filter(Boolean);
  const confirmPreview = () => {
    if (preview.videoWidth > 0 && !preview.paused) {
      window.clearTimeout(previewTimer);
      previewTimer = null;
      setJoinEnabled();
      setPermissionStatus(deviceIssues.length ? `Camera preview is live. ${deviceIssues.join(" ")}` : "Camera frames are visible. Check your microphone, then join when you’re comfortable.", deviceIssues.length ? "warning" : "good");
      return true;
    }
    return false;
  };
  if (videoTracks.length) {
    preview.onloadeddata = confirmPreview;
    preview.onplaying = confirmPreview;
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      if (preview.srcObject === replacement && preview.videoWidth === 0) {
        setPermissionStatus("Camera opened but no video frames arrived. Choose another camera, close camera apps, or retry.", "error");
        setJoinEnabled();
      }
    }, 5000);
    try {
      await preview.play();
      preview.onclick = null;
      if (!confirmPreview()) setPermissionStatus(deviceIssues.length ? deviceIssues.join(" ") : "Camera and microphone connected. Waiting for camera frames before you can join…", deviceIssues.length ? "error" : "warning");
    } catch (error) {
      setPermissionStatus("Camera is ready, but preview playback was blocked. Click the preview to start it.", "error");
      preview.onclick = () => preview.play().then(() => {
        preview.onclick = null;
        confirmPreview();
      }).catch((playError) => setPermissionStatus("Preview playback is still blocked: " + playError.message + ". Check this site’s browser permission.", "error"));
    }
  } else {
    preview.onclick = null;
    window.clearTimeout(previewTimer);
    preview.srcObject = null;
  }
  videoTracks[0]?.addEventListener("ended", onLocalCameraEnded);
  audioTracks[0]?.addEventListener("ended", onLocalMicrophoneEnded);
  old?.getTracks().forEach((track) => track.stop());
  await refreshDeviceLists();
  if (deviceIssues.length && (!videoTracks.length || preview.videoWidth === 0)) {
    setPermissionStatus(deviceIssues.join(" "), "error");
  } else if (!videoTracks.length) {
    setPermissionStatus("Microphone is ready. Camera access is required before joining the interview.", "error");
  }
  setJoinEnabled();
}

async function prepareLobby() {
  try {
    setPermissionStatus("Checking that this room is ready…");
    await validateRoom();
    setPermissionStatus("Allow camera and microphone access in your browser to preview your devices.");
    await acquireMedia();
  } catch (error) {
    setPermissionStatus(error.message, "error");
    $("join-room-btn").disabled = true;
  }
}

async function changeDevices() {
  try {
    setPermissionStatus("Switching devices…");
    await acquireMedia();
  } catch (error) {
    setPermissionStatus(`${error.name === "NotAllowedError" ? "Permission denied" : "Device unavailable"}: ${error.message}. Choose another device or allow access, then retry.`, "error");
    setJoinEnabled();
  }
}

async function joinInterview() {
  if ($("join-room-btn").disabled || joined) return;
  const button = $("join-room-btn");
  button.disabled = true;
  button.textContent = "Joining the room…";
  try {
    await validateRoom();
    await connectInterview();
    joined = true;
    $("prejoin").hidden = true;
    $("call-shell").hidden = false;
    attachLocalVideo();
    button.textContent = "Joined";
    if (auth.role === "hr") {
      addEvent("You opened the interview room.", "system");
      startQualityLog();
    }
  } catch (error) {
    button.textContent = "Join interview →";
    setPermissionStatus(error.message, "error");
    button.disabled = false;
  }
}

async function connectInterview() {
  const iceResponse = await fetch("/api/config/ice-servers", {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const iceConfig = iceResponse.ok ? await iceResponse.json() : { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  if (!iceConfig.turnConfigured) {
    showMessage("TURN relay is not configured. Calls may work on some separate networks but restrictive networks can fail. Configure a verified TURN service before relying on cross-network calls.", "warning");
    if (auth.role === "hr") addEvent("TURN relay is not configured. Cross-network connectivity is not guaranteed.", "review");
  }
  pc = new RTCPeerConnection({ iceServers: iceConfig.iceServers });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "webrtc", payload: { kind: "candidate", candidate } });
  };
  pc.onicecandidateerror = (event) => console.warn("ICE candidate error", event.errorCode, event.errorText);
  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    const isScreenVideo = event.track.kind === "video" && remoteShareActive;
    const mediaElement = isScreenVideo ? $("remote-screen-video") : $("remote-video");
    if (mediaElement.srcObject !== stream) mediaElement.srcObject = stream;
    if (!isScreenVideo) {
      mediaElement.muted = false;
      mediaElement.playsInline = true;
      if (event.track.kind === "video") {
        $("remote-tag").textContent = event.from || "Interview partner";
        updateRemoteCamera(remoteCameraEnabled);
      } else {
        remoteMicrophoneMuted = event.track.muted || !event.track.enabled;
        updateRemoteStatus();
      }
    } else {
      $("remote-screen-tile").hidden = false;
    }
    mediaElement.play().catch((error) => {
      $("enable-audio").hidden = false;
      showMessage(error.name === "NotAllowedError"
        ? "Your browser paused interview playback. Select Enable interview audio to hear your partner."
        : "Remote media could not start: " + error.message, "warning");
    });
    event.track.addEventListener("mute", () => {
      if (event.track.kind === "audio" && !isScreenVideo) {
        remoteMicrophoneMuted = true;
        updateRemoteStatus();
      }
    });
    event.track.addEventListener("unmute", () => {
      if (event.track.kind === "audio" && !isScreenVideo) {
        remoteMicrophoneMuted = false;
        updateRemoteStatus();
      }
    });
    event.track.addEventListener("ended", () => {
      if (isScreenVideo) $("remote-screen-tile").hidden = true;
      else if (event.track.kind === "audio") {
        remoteMicrophoneMuted = true;
        updateRemoteStatus();
      }
      else if (event.track.kind === "video") {
        $("remote-placeholder").hidden = false;
        $("remote-placeholder").querySelector("span:last-child").textContent = "Partner camera unavailable";
        $("remote-live-dot").hidden = true;
      }
    }, { once: true });
  };
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      $("conn-pill").textContent = "Connected";
      $("conn-pill").classList.add("connected");
      if (auth.role === "candidate") reportEvent("peer_connected");
    } else if (state === "failed") {
      $("conn-pill").textContent = "Connection failed · retrying ICE";
      showMessage("The media path failed. Trying an ICE restart; restrictive networks may require TURN.", "error");
      if (auth.role === "candidate") { reportEvent("peer_reconnecting"); send({ type: "renegotiate_request", restart_ice: true }); }
      else makeOffer(true);
    } else if (["disconnected", "connecting"].includes(state)) {
      $("conn-pill").textContent = state === "connecting" ? "Connecting…" : "Reconnecting…";
      if (auth.role === "candidate" && state === "disconnected") { reportEvent("peer_reconnecting"); send({ type: "renegotiate_request", restart_ice: true }); }
      if (state === "disconnected" && auth.role === "hr" && !reconnectTimer) {
        const currentPc = pc;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (pc === currentPc && pc.connectionState === "disconnected") makeOffer(true);
        }, 4000);
      }
    }
  };
  pc.onnegotiationneeded = () => {
    if (!joined && ws?.readyState !== WebSocket.OPEN) return;
    if (auth.role === "hr") makeOffer();
    else send({ type: "renegotiate_request" });
  };
  openSocket();
  $("conn-pill").textContent = "Waiting for interviewer";
}

function openSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws/${encodeURIComponent(roomId)}?token=${encodeURIComponent(auth.token)}`);
  ws.onopen = () => {
    $("conn-pill").textContent = "Waiting for interview partner";
    send({ type: "room_event", event: "peer_connected" });
  };
  ws.onerror = () => showMessage("The room signaling connection could not be reached.", "error");
  ws.onclose = (event) => {
    if (left) return;
    const details = event.code === 4409 ? "This room is full or already has someone in your role. Return to your workspace and check the code." : event.code === 4404 ? "This room code was not found or has expired. Ask HR to create a new room." : event.code === 4401 ? "Your sign-in expired. Sign in again and rejoin." : "The room signaling connection ended. Rejoin the room to continue.";
    showMessage(details, "error");
    $("conn-pill").textContent = "Disconnected";
    if (auth.role === "hr") addEvent(details, "review");
  };
  ws.onmessage = async (messageEvent) => {
    let msg;
    try { msg = JSON.parse(messageEvent.data); } catch { return; }
    if (msg.type === "system") {
      if (msg.event === "room_full") return;
      if (msg.event === "room_state") {
        peerPresent = msg.peers.some((peer) => peer.role !== auth.role);
        if (peerPresent) {
          remoteCameraEnabled = true;
          remoteMicrophoneMuted = false;
          updateRemoteStatus();
          const partner = msg.peers.find((peer) => peer.role !== auth.role);
          $("remote-tag").textContent = partner?.name || "Interview partner";
          $("conn-pill").textContent = "Partner is in the room";
          if (auth.role === "hr") makeOffer();
        }
      } else if (msg.event === "peer_joined") {
        peerPresent = true;
        remoteCameraEnabled = true;
        remoteMicrophoneMuted = false;
        updateRemoteStatus();
        $("remote-tag").textContent = msg.name || "Interview partner";
        $("remote-placeholder").querySelector("span:last-child").textContent = `${msg.name || "Your partner"} is connecting…`;
        $("conn-pill").textContent = "Partner is in the room";
        if (auth.role === "hr") makeOffer();
        if (auth.role === "hr") addEvent(`${msg.name} joined the room.`, "system");
      } else if (msg.event === "peer_left") {
        peerPresent = false;
        $("remote-video").srcObject = null;
        $("remote-screen-video").srcObject = null;
        $("remote-screen-tile").hidden = true;
        remoteShareActive = false;
        remoteCameraEnabled = true;
        remoteMicrophoneMuted = false;
        updateRemoteStatus();
        $("remote-placeholder").hidden = false;
        $("remote-waiting").textContent = "Waiting for your interview partner";
        $("remote-live-dot").hidden = true;
        $("conn-pill").textContent = "Partner left";
        if (auth.role === "hr") addEvent(`${msg.name} left the room.`, "review");
      }
    } else if (msg.type === "webrtc") {
      await onWebRtc(msg.payload);
    } else if (msg.type === "chat") {
      renderChat(msg.from, msg.text, false, msg.role);
    } else if (msg.type === "question") {
      renderQuestion(msg, false);
      switchTab("questions");
    } else if (msg.type === "answer") {
      renderAnswer(msg);
      if (auth.role === "hr") addEvent(`${msg.from} submitted an answer.`, "system");
    } else if (msg.type === "error") {
      showMessage(msg.message || "The room could not process that action.", "error");
    } else if (msg.type === "room_event") {
      if (msg.event === "candidate_mic_muted" || msg.event === "hr_mic_muted") {
        remoteMicrophoneMuted = true;
        updateRemoteStatus();
      } else if (msg.event === "candidate_mic_unmuted" || msg.event === "hr_mic_unmuted") {
        remoteMicrophoneMuted = false;
        updateRemoteStatus();
      }
      if (["candidate_camera_off", "hr_camera_off", "candidate_camera_interrupted", "hr_camera_interrupted"].includes(msg.event)) {
        updateRemoteCamera(false, msg.from);
      } else if (["candidate_camera_on", "hr_camera_on", "candidate_camera_restored", "hr_camera_restored"].includes(msg.event)) {
        updateRemoteCamera(true, msg.from);
      }
      if (auth.role === "hr") addEvent(eventDescription(msg.event, msg.from), msg.event.includes("hidden") || msg.event.includes("interrupted") || msg.event.includes("reconnecting") ? "review" : "system", msg.ts);
    } else if (msg.type === "screen_share_state") {
      remoteShareActive = msg.active;
      $("screen-sharer").textContent = msg.active ? msg.from : "Participant";
      if (!msg.active) $("remote-screen-tile").hidden = true;
    } else if (msg.type === "renegotiate_request") {
      if (auth.role === "hr") makeOffer(msg.restart_ice === true);
    }
  };
}

async function makeOffer(iceRestart = false) {
  if (auth.role !== "hr" || !peerPresent || !pc || pc.signalingState !== "stable" || makingOffer || ws?.readyState !== WebSocket.OPEN) return;
  makingOffer = true;
  try {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : {});
    await pc.setLocalDescription(offer);
    send({ type: "webrtc", payload: { kind: "offer", sdp: pc.localDescription } });
  } catch (error) {
    showMessage(`Could not start video negotiation: ${error.message}`, "error");
  } finally {
    makingOffer = false;
  }
}

async function onWebRtc(payload) {
  if (!payload || !pc) return;
  try {
    if (payload.kind === "offer") {
      await pc.setRemoteDescription(payload.sdp);
      for (const candidate of pendingIce) await pc.addIceCandidate(candidate);
      pendingIce = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "webrtc", payload: { kind: "answer", sdp: pc.localDescription } });
    } else if (payload.kind === "answer") {
      await pc.setRemoteDescription(payload.sdp);
      for (const candidate of pendingIce) await pc.addIceCandidate(candidate);
      pendingIce = [];
    } else if (payload.kind === "candidate" && payload.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
      else pendingIce.push(payload.candidate);
    }
  } catch (error) {
    console.warn("WebRTC negotiation failed", error);
    showMessage("Video setup needs another try. Check device permissions and network access, then leave and rejoin.", "error");
  }
}

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function showMessage(text, kind = "") {
  const element = $("room-message");
  element.textContent = text;
  element.className = `room-message ${kind}`.trim();
  element.hidden = false;
}

function updateRemoteCamera(enabled, name = "Your interview partner") {
  remoteCameraEnabled = enabled;
  const video = $("remote-video");
  const placeholder = $("remote-placeholder");
  if (!enabled) {
    $("remote-live-dot").hidden = true;
    placeholder.hidden = false;
    placeholder.querySelector("span:last-child").textContent = `${name} paused their camera`;
    updateRemoteStatus();
    return;
  }
  updateRemoteStatus();
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    placeholder.hidden = true;
    $("remote-live-dot").hidden = false;
  } else {
    placeholder.hidden = false;
    placeholder.querySelector("span:last-child").textContent = "Connecting to your interview partner’s camera…";
  }
}

function updateRemoteStatus() {
  const status = [];
  if (!remoteCameraEnabled) status.push("Camera off");
  if (remoteMicrophoneMuted) status.push("Microphone muted");
  $("remote-video-status").textContent = status.join(" · ");
}

$("remote-video").addEventListener("loadeddata", () => updateRemoteCamera(remoteCameraEnabled));
$("remote-video").addEventListener("playing", () => updateRemoteCamera(remoteCameraEnabled));

function attachLocalVideo() {
  const video = $("local-video");
  const placeholderText = $("local-placeholder").querySelector("span:last-child");
  const showFrame = () => {
    const track = localStream?.getVideoTracks()[0];
    if (video.videoWidth > 0 && video.videoHeight > 0 && track?.readyState === "live" && !track.muted && track.enabled) {
      cameraEnabled = true;
      updateCameraButton(true);
      window.clearTimeout(localVideoTimer);
      localVideoTimer = null;
      $("local-placeholder").hidden = true;
      $("reconnect-camera").hidden = true;
      $("local-video-status").textContent = "";
      return true;
    }
    return false;
  };
  video.onloadeddata = showFrame;
  video.onplaying = showFrame;
  const cameraTrack = localStream?.getVideoTracks()[0];
  cameraTrack?.addEventListener("mute", () => {
    if (left) return;
    $("local-placeholder").hidden = false;
    placeholderText.textContent = "Camera signal interrupted…";
    $("local-video-status").textContent = "Camera interrupted";
    $("reconnect-camera").hidden = false;
  });
  cameraTrack?.addEventListener("unmute", () => {
    if (!showFrame()) placeholderText.textContent = "Resuming your camera…";
  });
  video.srcObject = localStream;
  video.onclick = () => video.play().then(showFrame).catch((error) => showMessage("Local video playback is blocked: " + error.message, "error"));
  $("local-placeholder").hidden = false;
  placeholderText.textContent = "Starting your camera…";
  video.play().then(() => { if (!showFrame()) $("local-video-status").textContent = "Waiting for camera frames…"; })
    .catch((error) => {
      placeholderText.textContent = "Camera preview did not start. Check the selected device and browser permission, then rejoin.";
      $("local-video-status").textContent = error.name === "NotAllowedError" ? "Camera playback blocked" : "Camera unavailable";
      if (auth.role === "hr") addEvent(`Local camera preview failed: ${error.message}`, "review");
    });
  window.clearTimeout(localVideoTimer);
  localVideoTimer = window.setTimeout(() => {
    if (joined && video.srcObject === localStream && !showFrame()) {
      placeholderText.textContent = "No camera frames received. Check the selected camera and close other apps using it.";
      $("local-video-status").textContent = "No camera frames";
      cameraEnabled = false;
      updateCameraButton(false);
      $("reconnect-camera").hidden = false;
      if (auth.role === "hr") addEvent("No local camera frames received after joining. Check device selection and other camera apps.", "review");
    }
  }, 5000);
}

function reportEvent(event) {
  send({ type: "room_event", event });
}

function eventDescription(event, name) {
  const who = name || "Participant";
  const phrases = {
    candidate_tab_hidden: `${who} switched away from the interview tab. This may be for an ordinary reason; it is not evidence of misconduct.`,
    candidate_tab_returned: `${who} returned to the interview tab.`,
    candidate_camera_interrupted: `${who}’s camera feed was interrupted. Check for a device or permission issue.`,
    candidate_camera_restored: `${who}’s camera feed resumed.`,
    candidate_camera_off: `${who} turned their camera off.`, candidate_camera_on: `${who} turned their camera on.`,
    hr_camera_off: `${who} turned their camera off.`, hr_camera_on: `${who} turned their camera on.`,
    hr_camera_interrupted: `${who}’s camera feed was interrupted.`, hr_camera_restored: `${who}’s camera feed resumed.`,
    candidate_mic_muted: `${who} muted their microphone.`,
    candidate_mic_unmuted: `${who} unmuted their microphone.`,
    hr_mic_muted: `${who} muted their microphone.`, hr_mic_unmuted: `${who} unmuted their microphone.`,
    screen_share_started: `${who} started screen sharing.`, screen_share_stopped: `${who} stopped screen sharing.`,
    peer_reconnecting: `${who}’s network connection is reconnecting.`, peer_connected: `${who} connected to the interview room.`,
  };
  return phrases[event] || `${who}: ${event.replaceAll("_", " ")}.`;
}

function addEvent(text, type = "system", timestamp = new Date().toISOString()) {
  if (auth.role !== "hr") return;
  const entry = { text, type, timestamp };
  events.push(entry);
  if (events.length > 400) events.shift();
  const list = $("log-list");
  list.querySelector(".event-empty")?.remove();
  const item = document.createElement("div");
  item.className = `event-entry ${type}`;
  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = new Date(timestamp).toLocaleTimeString();
  item.append(time, document.createTextNode(text));
  list.prepend(item);
  while (list.children.length > 200) list.lastElementChild.remove();
}

async function startQualityLog() {
  window.clearInterval(qualityTimer);
  qualityTimer = window.setInterval(async () => {
    if (!pc || !joined || auth.role !== "hr") return;
    let detail = `Connection ${pc.connectionState}; media ${localStream?.active ? "available" : "unavailable"}`;
    try {
      const stats = await pc.getStats();
      const reports = [...stats.values()];
      const pair = reports.find((report) => report.type === "candidate-pair" && (report.selected || (report.nominated && report.state === "succeeded")));
      if (pair) {
        const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
        const route = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "TURN relay" : local?.candidateType && remote?.candidateType ? `direct (${local.candidateType}/${remote.candidateType})` : "selected path";
        detail += `; route ${route}`;
        if (pair.currentRoundTripTime != null) detail += `; network round trip ${Math.round(pair.currentRoundTripTime * 1000)} ms`;
      }
    } catch { detail += "; connection details unavailable"; }
    $("quality-summary").textContent = detail;
    if (pc.connectionState !== lastConnectionState) {
      addEvent(`Connection changed to ${pc.connectionState}.`, pc.connectionState === "failed" ? "review" : "system");
      lastConnectionState = pc.connectionState;
    }
    addEvent(`2-second status check — ${detail}. No audio or video was recorded.`, "system");
  }, 2000);
}

function exportLog() {
  if (!events.length) return showMessage("There are no session events to export yet.");
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = ["timestamp,type,event", ...events.map((event) => [quote(event.timestamp), quote(event.type), quote(event.text)].join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `neurofocus-${roomId}-session-log.csv`; link.click(); URL.revokeObjectURL(url);
}

function switchTab(name) {
  for (const tab of ["log", "questions", "chat"]) {
    $(`tab-${tab}`).classList.toggle("active", name === tab);
    $(`tab-btn-${tab}`).classList.toggle("active", name === tab);
  }
}

function renderChat(from, text, mine, role) {
  const message = document.createElement("div");
  message.className = `chat-msg${mine ? " mine" : ""}`;
  const sender = document.createElement("span"); sender.className = "who"; sender.textContent = `${from}${role ? ` · ${role}` : ""}`;
  message.append(sender, document.createTextNode(text));
  $("chat-messages").append(message);
  $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
}

function renderQuestion(question, mine) {
  $("qa-empty").hidden = true;
  const card = document.createElement("article"); card.className = "question-card";
  const type = document.createElement("div"); type.className = "question-label"; type.textContent = labels[question.category] || "Interview question";
  const heading = document.createElement("h3"); heading.textContent = question.text;
  const meta = document.createElement("div"); meta.className = "question-meta"; meta.textContent = `From ${question.from || auth.name}${mine ? " · sent" : ""}`;
  const answerList = document.createElement("div"); answerList.className = "answer-list";
  card.append(type, heading, meta, answerList);
  if (auth.role === "candidate" && !mine) {
    const form = document.createElement("form"); form.className = "composer question-answer-form";
    const language = document.createElement("select"); language.className = "answer-language"; language.setAttribute("aria-label", "Programming language");
    for (const [value, label] of [["python", "Python"], ["java", "Java"], ["javascript", "JavaScript"], ["html", "HTML"], ["css", "CSS"], ["cpp", "C++"], ["other", "Other / explanation"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; language.append(option); }
    language.hidden = question.category !== "coding";
    const area = document.createElement("textarea"); area.maxLength = 12000; area.required = true; area.placeholder = question.category === "coding" ? "Write your code or explain your approach…" : "Write your answer…";
    if (question.category === "coding") area.style.cssText = "font-family:ui-monospace,Consolas,monospace;min-height:130px;";
    const button = document.createElement("button"); button.className = "button small"; button.textContent = "Submit answer";
    form.append(language, area, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!area.value.trim()) return;
      if (ws?.readyState !== WebSocket.OPEN) return showMessage("The room connection was lost. Rejoin before submitting.", "error");
      send({ type: "answer", question_id: question.id, format: question.category === "coding" ? "code" : "text", language: question.category === "coding" ? language.value : "", text: area.value });
      area.disabled = true; button.disabled = true; button.textContent = "Answer submitted";
      const preview = document.createElement("pre"); preview.className = "answer-preview"; preview.textContent = question.category === "coding" ? `${language.options[language.selectedIndex].text}:\n${area.value}` : area.value; answerList.append(preview);
    });
    card.append(form);
  }
  questionCards.set(question.id, card);
  $("qa-list").prepend(card);
}

function renderAnswer(answer) {
  const card = questionCards.get(answer.question_id);
  if (!card) return;
  const preview = document.createElement("pre"); preview.className = "answer-preview";
  preview.textContent = `${answer.from}${answer.language ? ` · ${answer.language}` : ""}:\n${answer.text}`;
  card.querySelector(".answer-list").append(preview);
}

$("camera-select").addEventListener("change", changeDevices);
$("microphone-select").addEventListener("change", changeDevices);
$("retry-media").addEventListener("click", async () => {
  try { await refreshDeviceLists(); await acquireMedia(); }
  catch (error) { setPermissionStatus(`Camera/microphone not ready: ${error.message}`, "error"); }
});
$("consent-check").addEventListener("change", setJoinEnabled);
$("join-room-btn").addEventListener("click", joinInterview);
navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshDeviceLists().catch(() => {}));

$("mic-btn").addEventListener("click", () => {
  const tracks = localStream?.getAudioTracks() || [];
  if (!tracks.some((track) => track.readyState === "live")) return showMessage("Your microphone feed isn’t live. Rejoin after checking the device and browser permission.", "error");
  microphoneEnabled = !microphoneEnabled;
  tracks.forEach((track) => { track.enabled = microphoneEnabled; });
  const button = $("mic-btn"); button.classList.toggle("off", !microphoneEnabled); button.setAttribute("aria-pressed", String(!microphoneEnabled));
  button.setAttribute("aria-label", microphoneEnabled ? "Mute microphone" : "Unmute microphone");
  button.querySelector("small").textContent = microphoneEnabled ? "Mute" : "Unmute";
  reportEvent(`${auth.role === "hr" ? "hr" : "candidate"}_mic_${microphoneEnabled ? "unmuted" : "muted"}`);
  if (auth.role === "hr") addEvent(`Your microphone ${microphoneEnabled ? "was unmuted" : "was muted"}.`, "system");
});

function updateCameraButton(enabled) {
  const button = $("cam-btn");
  button.classList.toggle("off", !enabled);
  button.setAttribute("aria-pressed", String(!enabled));
  button.setAttribute("aria-label", enabled ? "Turn camera off" : "Turn camera on");
  button.querySelector("small").textContent = enabled ? "Camera" : "Camera off";
}

$("cam-btn").addEventListener("click", () => {
  const tracks = localStream?.getVideoTracks() || [];
  if (!tracks.some((track) => track.readyState === "live")) {
    $("reconnect-camera").hidden = false;
    return showMessage("Your camera feed isn’t live. Use Reconnect camera to restart it.", "error");
  }
  cameraEnabled = !cameraEnabled;
  tracks.forEach((track) => { track.enabled = cameraEnabled; });
  updateCameraButton(cameraEnabled);
  $("local-video-status").textContent = cameraEnabled ? "" : "Camera off";
  const eventName = `${auth.role === "hr" ? "hr" : "candidate"}_camera_${cameraEnabled ? "on" : "off"}`;
  reportEvent(eventName);
  if (auth.role === "hr") addEvent(`Your camera was ${cameraEnabled ? "turned on" : "turned off"}.`, "system");
});

$("enable-audio").addEventListener("click", async () => {
  try {
    const video = $("remote-video");
    video.muted = false;
    await video.play();
    $("enable-audio").hidden = true;
    $("room-message").hidden = true;
  } catch (error) {
    showMessage(`Playback is still blocked: ${error.message}. Check this site’s sound permission and try again.`, "error");
  }
});

async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return showMessage("Screen sharing isn’t supported by this browser. Try a recent version of Chrome, Edge, or Firefox.", "error");
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = displayStream.getVideoTracks()[0];
    $("local-screen-video").srcObject = displayStream;
    $("local-screen-tile").hidden = false;
    $("local-screen-video").play().catch(() => {});
    if (!screenSender) screenSender = pc.addTrack(track, displayStream);
    else await screenSender.replaceTrack(track);
    track.addEventListener("ended", stopScreenShare, { once: true });
    send({ type: "screen_share_state", active: true }); reportEvent("screen_share_started");
    const button = $("share-btn"); button.classList.add("active"); button.setAttribute("aria-pressed", "true"); button.querySelector("small").textContent = "Stop share";
  } catch (error) {
    if (error.name !== "AbortError") showMessage(`Screen sharing didn’t start: ${error.message}`, "error");
  }
}

async function stopScreenShare() {
  if (!displayStream) return;
  const old = displayStream; displayStream = null;
  old.getTracks().forEach((track) => { if (track.readyState === "live") track.stop(); });
  $("local-screen-video").srcObject = null; $("local-screen-tile").hidden = true;
  try { if (screenSender) await screenSender.replaceTrack(null); } catch {}
  send({ type: "screen_share_state", active: false }); reportEvent("screen_share_stopped");
  const button = $("share-btn"); button.classList.remove("active"); button.setAttribute("aria-pressed", "false"); button.querySelector("small").textContent = "Share screen";
}

$("share-btn").addEventListener("click", () => displayStream ? stopScreenShare() : startScreenShare());
$("questions-shortcut").addEventListener("click", () => switchTab("questions"));
document.querySelectorAll(".sidebar-tabs [data-tab]").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
$("export-log").addEventListener("click", exportLog);

$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("chat-input"), text = input.value.trim().slice(0, 1000);
  if (!text) return;
  if (ws?.readyState !== WebSocket.OPEN) return showMessage("The room connection was lost. Rejoin before sending a message.", "error");
  send({ type: "chat", text }); renderChat(auth.name, text, true, auth.role); input.value = "";
});

$("question-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("question-text"), text = input.value.trim();
  if (!text) return;
  if (ws?.readyState !== WebSocket.OPEN) return showMessage("The room connection was lost. Rejoin before sending a question.", "error");
  const question = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, text, category: $("question-category").value, from: auth.name };
  send({ type: "question", ...question }); renderQuestion(question, true); input.value = ""; addEvent(`You shared a ${labels[question.category].toLowerCase()} question.`, "system");
});

function onLocalCameraEnded(event) {
  if (left || (event?.target && localStream?.getVideoTracks().some((track) => track !== event.target && track.readyState === "live"))) return;
  $("local-placeholder").hidden = false;
  $("local-placeholder").querySelector("span:last-child").textContent = "Camera feed unavailable";
  $("local-video-status").textContent = "Camera interrupted";
  cameraEnabled = false;
  updateCameraButton(false);
  $("reconnect-camera").hidden = false;
  if (joined && auth.role === "candidate" && !left) reportEvent("candidate_camera_interrupted");
  if (joined && auth.role === "hr" && !left) reportEvent("hr_camera_interrupted");
  if (auth.role === "hr") addEvent("Your camera feed was interrupted. Check the camera device or permission.", "review");
}
function onLocalMicrophoneEnded() {
  microphoneEnabled = false;
  const button = $("mic-btn");
  button.classList.add("off");
  button.setAttribute("aria-pressed", "true");
  button.setAttribute("aria-label", "Microphone unavailable");
  button.querySelector("small").textContent = "Mic unavailable";
  showMessage("Your microphone feed was interrupted. Check the device and browser permission, then rejoin.", "error");
  if (auth.role === "hr") addEvent("Your microphone feed was interrupted. Check the audio device or permission.", "review");
}

async function reconnectCamera() {
  const retryButton = $("reconnect-camera");
  retryButton.disabled = true;
  retryButton.textContent = "Reconnecting…";
  try {
    const deviceId = $("camera-select").value;
    const stream = await captureMedia("video", deviceId);
    const nextTrack = stream.getVideoTracks()[0];
    if (!nextTrack) throw new Error("The browser did not return a camera video track.");
    const oldTrack = localStream?.getVideoTracks()[0];
    const sender = pc?.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) throw new Error("The camera sender is not available. Leave and rejoin the room.");
    await sender.replaceTrack(nextTrack);
    if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
    localStream.addTrack(nextTrack);
    cameraEnabled = false;
    nextTrack.enabled = true;
    updateCameraButton(false);
    $("local-video").srcObject = localStream;
    attachLocalVideo();
    reportEvent((auth.role === "hr" ? "hr" : "candidate") + "_camera_restored");
    if (auth.role === "hr") addEvent("Your camera feed resumed.", "system");
  } catch (error) {
    showMessage("Could not reconnect the camera: " + error.message + ". Check the device and browser permission, then try again.", "error");
  } finally {
    retryButton.disabled = false;
    retryButton.textContent = "Reconnect camera";
  }
}

$("reconnect-camera").addEventListener("click", reconnectCamera);

document.addEventListener("visibilitychange", () => {
  if (!joined || left || auth.role !== "candidate") return;
  reportEvent(document.hidden ? "candidate_tab_hidden" : "candidate_tab_returned");
});

function leaveInterview() {
  if (left) return;
  left = true; window.clearInterval(qualityTimer); window.clearTimeout(reconnectTimer); window.clearTimeout(previewTimer); window.clearTimeout(localVideoTimer);
  if (displayStream) displayStream.getTracks().forEach((track) => track.stop());
  localStream?.getTracks().forEach((track) => track.stop());
  pc?.close(); ws?.close(1000, "left interview");
  location.href = "/dashboard.html";
}
$("leave-btn").addEventListener("click", leaveInterview);
window.addEventListener("pagehide", () => {
  left = true; window.clearInterval(qualityTimer); window.clearTimeout(reconnectTimer); window.clearTimeout(previewTimer); window.clearTimeout(localVideoTimer);
  displayStream?.getTracks().forEach((track) => track.stop());
  localStream?.getTracks().forEach((track) => track.stop());
  pc?.close(); ws?.close();
});

prepareLobby();
