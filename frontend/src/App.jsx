import { useEffect, useRef, useState } from "react";
import { getSignalingUrl, hasStaticSignalingUrl, saveSignalingUrl } from "./signalingUrl";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

if (import.meta.env.VITE_TURN_URL) {
  ICE_SERVERS.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME || undefined,
    credential: import.meta.env.VITE_TURN_CREDENTIAL || undefined
  });
}

/** Pool size 0 = faster first connection; increase only if you see ICE failures */
const RTC_CONFIG = { iceServers: ICE_SERVERS, iceCandidatePoolSize: 0 };
const socketIoClientPromise = import("socket.io-client");

function toValidUserId(value) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "");
  if (normalized.length >= 3) return normalized.slice(0, 24);
  const fallback = `user_${Math.random().toString(36).slice(2, 8)}`;
  return fallback;
}

export default function App() {
  const [displayName, setDisplayName] = useState("");
  const [myUserId, setMyUserId] = useState("");
  const [shareUserId, setShareUserId] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [status, setStatus] = useState("Enter a username and display name to start.");
  const [onlineUsers, setOnlineUsers] = useState([]);

  const [outgoingRinging, setOutgoingRinging] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [incoming, setIncoming] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [connectionState, setConnectionState] = useState("idle");
  const [isRegistering, setIsRegistering] = useState(false);
  const [audioInputs, setAudioInputs] = useState([]);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [selectedMicId, setSelectedMicId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [signalingUrl, setSignalingUrl] = useState(() => getSignalingUrl());
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSharingSystemAudio, setIsSharingSystemAudio] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isOnHold, setIsOnHold] = useState(false);
  const [callElapsedSec, setCallElapsedSec] = useState(0);

  const [logs, setLogs] = useState([]);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const localAudioRef = useRef(null);
  const micStreamRef = useRef(null);
  const systemAudioStreamRef = useRef(null);

  const remoteSocketRef = useRef(null);
  const pendingCalleeRef = useRef(null);
  const ringTimerRef = useRef(null);
  const audioContextRef = useRef(null);
  const vibrationTimerRef = useRef(null);
  const isRegisteringRef = useRef(false);
  const registeredRef = useRef(false);
  const vibrationEnabledRef = useRef(true);
  const callStartAtRef = useRef(null);

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function canUseVibration() {
    if (!vibrationEnabledRef.current) return false;
    if (typeof window === "undefined" || !navigator.vibrate) return false;
    // Embedded previews (iframe/webview) commonly block vibration with console intervention warnings.
    try {
      if (window.self !== window.top) return false;
    } catch {
      return false;
    }
    if (navigator.userActivation?.hasBeenActive !== true) return false;
    return true;
  }

  function stopRingFeedback() {
    if (ringTimerRef.current) {
      clearInterval(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (vibrationTimerRef.current) {
      clearInterval(vibrationTimerRef.current);
      vibrationTimerRef.current = null;
    }
    if (!canUseVibration()) return;
    try {
      navigator.vibrate(0);
    } catch {
      vibrationEnabledRef.current = false;
    }
  }

  function playBeep(frequency = 880, durationMs = 180) {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") ctx.resume();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + durationMs / 1000);
    } catch {
      // Some browsers may block autoplay audio until interaction.
    }
  }

  function startIncomingRingFeedback() {
    stopRingFeedback();
    playBeep(790, 200);
    ringTimerRef.current = setInterval(() => {
      playBeep(790, 180);
      setTimeout(() => playBeep(980, 180), 220);
    }, 1500);
    if (canUseVibration()) {
      try {
        navigator.vibrate([350, 200, 350]);
      } catch {
        vibrationEnabledRef.current = false;
        return;
      }
      vibrationTimerRef.current = setInterval(() => {
        if (!canUseVibration()) return;
        try {
          navigator.vibrate([300, 180, 300]);
        } catch {
          vibrationEnabledRef.current = false;
        }
      }, 1600);
    }
  }

  function startOutgoingRingFeedback() {
    stopRingFeedback();
    playBeep(520, 140);
    ringTimerRef.current = setInterval(() => playBeep(520, 140), 1300);
  }

  function getPreferredMicConstraints() {
    return selectedMicId ? { audio: { deviceId: { exact: selectedMicId } }, video: false } : { audio: true, video: false };
  }

  async function refreshAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    setAudioInputs(inputs);
    setAudioOutputs(outputs);
    setSelectedMicId((current) =>
      current === "" || inputs.some((d) => d.deviceId === current) ? current : ""
    );
    setSelectedSpeakerId((current) =>
      current === "" || outputs.some((d) => d.deviceId === current) ? current : ""
    );
  }

  async function applySpeakerSelection(deviceId) {
    const audioEl = remoteAudioRef.current;
    if (!audioEl) return;
    if (typeof audioEl.setSinkId !== "function") return;
    await audioEl.setSinkId(deviceId || "");
  }

  async function getLocalMedia() {
    if (!localStreamRef.current) {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia(getPreferredMicConstraints());
      micStreamRef.current = localStreamRef.current;
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = localStreamRef.current;
      }
      await refreshAudioDevices();
    }
    return localStreamRef.current;
  }

  async function switchMicrophone(deviceId) {
    const nextStream = await navigator.mediaDevices.getUserMedia(
      deviceId ? { audio: { deviceId: { exact: deviceId } }, video: false } : { audio: true, video: false }
    );
    const nextTrack = nextStream.getAudioTracks()[0];
    if (!nextTrack) {
      nextStream.getTracks().forEach((t) => t.stop());
      throw new Error("No audio track available");
    }

    if (peerConnectionRef.current) {
      const sender = peerConnectionRef.current
        .getSenders()
        .find((s) => s.track && s.track.kind === "audio");
      if (sender) {
        await sender.replaceTrack(nextTrack);
      } else {
        peerConnectionRef.current.addTrack(nextTrack, nextStream);
      }
    }

    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = nextStream;
    micStreamRef.current = nextStream;
    if (localAudioRef.current) {
      localAudioRef.current.srcObject = nextStream;
    }
    await refreshAudioDevices();
  }

  async function replaceOutgoingAudioTrack(nextTrack, owningStream) {
    if (!peerConnectionRef.current) return;
    const sender = peerConnectionRef.current
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (sender) {
      await sender.replaceTrack(nextTrack);
      return;
    }
    peerConnectionRef.current.addTrack(nextTrack, owningStream);
  }

  function getOutgoingAudioSender() {
    const pc = peerConnectionRef.current;
    if (!pc) return null;
    return pc.getSenders().find((s) => s.track && s.track.kind === "audio") ?? null;
  }

  async function toggleMute() {
    const sender = getOutgoingAudioSender();
    if (!sender?.track) {
      setStatus("No outgoing audio track yet.");
      return;
    }
    const next = !isMuted;
    sender.track.enabled = !next;
    setIsMuted(next);
    setStatus(next ? "Muted." : "Unmuted.");
  }

  async function toggleHold() {
    const next = !isOnHold;
    const sender = getOutgoingAudioSender();
    if (sender?.track) {
      // Hold pauses sending audio regardless of mute state.
      sender.track.enabled = !next && !isMuted;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = next;
    }
    setIsOnHold(next);
    setStatus(next ? "On hold." : "Resumed.");
  }

  async function startSystemAudioShare() {
    try {
      // Desktop EXE: prefer getDisplayMedia once Electron enables it via setDisplayMediaRequestHandler.
      if (window.__vvDesktop?.isElectron && navigator.mediaDevices?.getDisplayMedia) {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const audioTrack = displayStream.getAudioTracks()[0];
        if (!audioTrack) {
          displayStream.getTracks().forEach((t) => t.stop());
          setStatus("No system audio track was captured. Try again and ensure audio is available.");
          return;
        }

        systemAudioStreamRef.current?.getTracks().forEach((t) => t.stop());
        systemAudioStreamRef.current = displayStream;
        audioTrack.onended = () => {
          stopSystemAudioShare().catch(() => {});
        };

        if (!micStreamRef.current) {
          await getLocalMedia();
        }
        await replaceOutgoingAudioTrack(audioTrack, displayStream);
        audioTrack.enabled = !isMuted && !isOnHold;
        setIsSharingSystemAudio(true);
        setStatus("Sharing screen audio.");
        return;
      }

      // Electron desktop build: use desktopCapturer to reliably capture system audio.
      const desktopApi = window.__vvDesktop || window.desktopCapture;
      const sources =
        desktopApi && typeof desktopApi.getSources === "function"
          ? await desktopApi.getSources().catch(() => null)
          : null;
      if (sources && navigator.mediaDevices?.getUserMedia) {
        const choice = window.prompt(
          `Select what to share (enter number):\n\n${sources
            .slice(0, 20)
            .map((s, i) => `${i + 1}. ${s.name}`)
            .join("\n")}\n\nTip: choose your screen.`,
          "1"
        );
        const idx = Number(choice) - 1;
        const source = sources[idx];
        if (!source) {
          setStatus("System audio share cancelled.");
          return;
        }

        const tryGetDesktopStream = async () => {
          // Windows Electron can throw NotSupportedError depending on constraint shape.
          // Try a couple of known-good variants.
          try {
            return await navigator.mediaDevices.getUserMedia({
              audio: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: source.id
                }
              },
              video: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: source.id
                }
              }
            });
          } catch (e1) {
            if (e1?.name !== "NotSupportedError") throw e1;
            return await navigator.mediaDevices.getUserMedia({
              audio: {
                mandatory: {
                  chromeMediaSource: "desktop"
                }
              },
              video: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: source.id
                }
              }
            });
          }
        };

        let displayStream;
        try {
          displayStream = await tryGetDesktopStream();
        } catch (e2) {
          // Fallback: use screen-share picker with audio (more reliable on some setups).
          if (navigator.mediaDevices?.getDisplayMedia) {
            displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
          } else {
            throw e2;
          }
        }

        const audioTrack = displayStream.getAudioTracks()[0];
        if (!audioTrack) {
          displayStream.getTracks().forEach((t) => t.stop());
          setStatus("No system audio track was captured. In the picker, enable 'Share audio'.");
          return;
        }

        systemAudioStreamRef.current?.getTracks().forEach((t) => t.stop());
        systemAudioStreamRef.current = displayStream;

        audioTrack.onended = () => {
          stopSystemAudioShare().catch(() => {});
        };

        if (!micStreamRef.current) {
          await getLocalMedia();
        }

        await replaceOutgoingAudioTrack(audioTrack, displayStream);
        // Respect current mute/hold state on the newly swapped track.
        audioTrack.enabled = !isMuted && !isOnHold;
        setIsSharingSystemAudio(true);
        setStatus("Sharing screen audio.");
        return;
      }

      if (!navigator.mediaDevices?.getDisplayMedia) {
        setStatus("System audio sharing is not supported here (desktop capture bridge missing).");
        return;
      }

      // Browser path: user must enable “Share audio” in picker.
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      const audioTrack = displayStream.getAudioTracks()[0];
      if (!audioTrack) {
        displayStream.getTracks().forEach((t) => t.stop());
        setStatus("No system audio track was shared. In the picker, enable 'Share audio'.");
        return;
      }

      systemAudioStreamRef.current?.getTracks().forEach((t) => t.stop());
      systemAudioStreamRef.current = displayStream;

      // Stop sharing if user ends it from browser UI.
      audioTrack.onended = () => {
        stopSystemAudioShare().catch(() => {});
      };

      if (!micStreamRef.current) {
        await getLocalMedia();
      }

      await replaceOutgoingAudioTrack(audioTrack, displayStream);
      audioTrack.enabled = !isMuted && !isOnHold;
      setIsSharingSystemAudio(true);
      setStatus("Sharing screen audio.");
    } catch (err) {
      const isAudioSourceStartFailure =
        typeof err?.message === "string" &&
        err.message.toLowerCase().includes("could not start audio source");
      const msg = isAudioSourceStartFailure
        ? "System audio capture failed on this PC output device. Try switching Windows output device (e.g. speakers/headphones), close apps locking audio, then retry."
        : err?.name === "NotAllowedError"
          ? "Permission denied. Try again and allow screen/audio capture."
          : err?.message
            ? `Could not start system audio sharing: ${err.message}`
            : "Could not start system audio sharing.";
      setStatus(msg);
    }
  }

  async function stopSystemAudioShare() {
    systemAudioStreamRef.current?.getTracks().forEach((t) => t.stop());
    systemAudioStreamRef.current = null;

    const micStream = micStreamRef.current || (await getLocalMedia());
    const micTrack = micStream?.getAudioTracks()?.[0];
    if (micTrack && peerConnectionRef.current) {
      await replaceOutgoingAudioTrack(micTrack, micStream);
      micTrack.enabled = !isMuted && !isOnHold;
    }
    setIsSharingSystemAudio(false);
    setStatus("Stopped sharing system audio.");
  }

  async function ensurePeerConnection(remoteSocketId) {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnectionRef.current = pc;

    const localStream = await getLocalMedia();
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      socketRef.current?.emit("webrtc-ice-candidate", {
        to: remoteSocketId,
        candidate: event.candidate
      });
    };

    pc.ontrack = (event) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
        applySpeakerSelection(selectedSpeakerId).catch(() => {
          setStatus("Connected, but could not apply selected speaker output.");
        });
        remoteAudioRef.current.play().catch(() => {
          setStatus("Connected, but audio playback is blocked. Tap anywhere and try again.");
        });
      }
    };

    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState);
      if (pc.connectionState === "connected") {
        setStatus("In call");
      }
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setStatus("Connection dropped. If users are on different networks, add TURN server env vars.");
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        setStatus("Could not establish media path. TURN server may be required.");
      }
    };

    return pc;
  }

  function closePeerConnection() {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    setConnectionState("idle");
  }

  function attachSocketListeners(socket) {
    socket.on("connect_error", () => {
      if (isRegisteringRef.current || registeredRef.current) {
        setStatus("Cannot reach server. Check internet or try again in a moment.");
      }
      setIsRegistering(false);
      isRegisteringRef.current = false;
    });

    socket.on("registered", ({ userId }) => {
      setRegistered(true);
      setMyUserId(userId);
      setStatus("Ready. Select an online user and tap call.");
      setIsRegistering(false);
      isRegisteringRef.current = false;
    });

    socket.on("online-users", (users) => {
      setOnlineUsers(users);
      setSelectedUserId((current) => (users.some((u) => u.userId === current) ? current : ""));
    });

    socket.on("register-failed", () =>
      {
        setStatus("Invalid username. Use at least 3 chars: letters, numbers, _, -, .");
        setIsRegistering(false);
        isRegisteringRef.current = false;
      }
    );

    socket.on("start-call-failed", ({ reason }) => {
      setOutgoingRinging(false);
      setInCall(false);
      pendingCalleeRef.current = null;
      const msg =
        reason === "offline"
          ? "That user is offline."
          : reason === "self"
            ? "You cannot call yourself."
            : "Call failed.";
      setStatus(msg);
    });

    socket.on("call-ringing", ({ targetSocketId }) => {
      pendingCalleeRef.current = targetSocketId;
      setOutgoingRinging(true);
      setStatus("Ringing…");
      startOutgoingRingFeedback();
    });

    socket.on("incoming-call", ({ fromUserId, fromName, callerLabel, fromSocketId }) => {
      setIncoming({ fromUserId, fromName, callerLabel, fromSocketId });
      setStatus(`Incoming call from ${callerLabel ?? `${fromName} (@${fromUserId})`}`);
      startIncomingRingFeedback();
    });

    socket.on("incoming-cancelled", () => {
      setIncoming(null);
      setStatus("Missed / cancelled call.");
      stopRingFeedback();
    });

    socket.on("remote-answered", async ({ calleeSocketId }) => {
      remoteSocketRef.current = calleeSocketId;
      setOutgoingRinging(false);
      setStatus("Connecting…");
      stopRingFeedback();
      try {
        const pc = await ensurePeerConnection(calleeSocketId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", { to: calleeSocketId, sdp: offer });
      } catch {
        setStatus("Could not start call.");
      }
    });

    socket.on("call-rejected", () => {
      setOutgoingRinging(false);
      setInCall(false);
      pendingCalleeRef.current = null;
      closePeerConnection();
      setStatus("Call declined.");
      stopRingFeedback();
    });

    socket.on("webrtc-offer", async ({ from, fromName, sdp }) => {
      setStatus(`Call with ${fromName}`);
      await ensurePeerConnection(from);
      await peerConnectionRef.current.setRemoteDescription(sdp);
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socket.emit("webrtc-answer", { to: from, sdp: answer });
      remoteSocketRef.current = from;
      setIncoming(null);
      setInCall(true);
      stopRingFeedback();
    });

    socket.on("webrtc-answer", async ({ sdp }) => {
      await peerConnectionRef.current?.setRemoteDescription(sdp);
      setStatus("In call");
      setInCall(true);
      stopRingFeedback();
    });

    socket.on("webrtc-ice-candidate", async ({ candidate }) => {
      if (!candidate || !peerConnectionRef.current) return;
      await peerConnectionRef.current.addIceCandidate(candidate);
    });

    socket.on("call-ended", () => {
      closePeerConnection();
      remoteSocketRef.current = null;
      pendingCalleeRef.current = null;
      setOutgoingRinging(false);
      setInCall(false);
      setIncoming(null);
      setStatus("Call ended.");
      stopRingFeedback();
    });
  }

  function cleanupAllMedia() {
    closePeerConnection();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    systemAudioStreamRef.current?.getTracks().forEach((t) => t.stop());
    systemAudioStreamRef.current = null;
    setIsSharingSystemAudio(false);
    setIsMuted(false);
    setIsOnHold(false);
  }

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices?.addEventListener) {
      mediaDevices.addEventListener("devicechange", refreshAudioDevices);
    }
    refreshAudioDevices().catch(() => {
      // Device labels may be limited until mic permission is granted.
    });
    return () => {
      stopRingFeedback();
      if (mediaDevices?.removeEventListener) {
        mediaDevices.removeEventListener("devicechange", refreshAudioDevices);
      }
      socketRef.current?.disconnect();
      socketRef.current = null;
      cleanupAllMedia();
      audioContextRef.current?.close();
    };
  }, []);

  useEffect(() => {
    isRegisteringRef.current = isRegistering;
  }, [isRegistering]);

  useEffect(() => {
    registeredRef.current = registered;
  }, [registered]);

  useEffect(() => {
    if (!inCall) {
      callStartAtRef.current = null;
      setCallElapsedSec(0);
      return;
    }
    if (!callStartAtRef.current) {
      callStartAtRef.current = Date.now();
    }
    setCallElapsedSec(Math.floor((Date.now() - callStartAtRef.current) / 1000));
    const timer = setInterval(() => {
      if (!callStartAtRef.current) return;
      setCallElapsedSec(Math.floor((Date.now() - callStartAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [inCall]);

  useEffect(() => {
    let cancelled = false;
    const warmSocket = async () => {
      try {
        const socket = await ensureSocket();
        if (cancelled) return;
        if (!socket.connected) socket.connect();
      } catch {
        // Ignore warmup failures; explicit register flow will still retry.
      }
    };
    void warmSocket();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applySpeakerSelection(selectedSpeakerId).catch(() => {
      // setSinkId is unavailable in some browsers/devices.
    });
  }, [selectedSpeakerId]);

  async function ensureSocket() {
    if (!signalingUrl) {
      throw new Error("Missing signaling URL");
    }
    if (socketRef.current) return socketRef.current;
    const { io } = await socketIoClientPromise;
    const socket = io(signalingUrl, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      timeout: 20000,
      reconnectionAttempts: 5
    });
    attachSocketListeners(socket);
    socketRef.current = socket;
    return socket;
  }

  async function doRegister() {
    if (!displayName.trim()) {
      setStatus("Enter your name to continue.");
      return;
    }
    const userId = myUserId.trim()
      ? toValidUserId(myUserId.trim())
      : toValidUserId(displayName.trim());
    if (myUserId !== userId) {
      setMyUserId(userId);
    }
    if (!signalingUrl) {
      setStatus("Set your signaling server URL to continue.");
      return;
    }
    if (!hasStaticSignalingUrl()) {
      const persisted = saveSignalingUrl(signalingUrl);
      if (persisted && signalingUrl !== persisted) {
        setSignalingUrl(persisted);
      }
    }
    setStatus("Connecting…");
    setIsRegistering(true);
    isRegisteringRef.current = true;
    try {
      const socket = await ensureSocket();
      const sendRegister = () => {
        socket.emit("register", {
          userId,
          displayName: displayName.trim(),
          shareUserId
        });
        setStatus("Registering…");
      };

      if (socket.connected) {
        sendRegister();
        return;
      }

      socket.once("connect", sendRegister);
      socket.connect();
    } catch {
      setStatus("Could not load network module. Check connection and try again.");
      setIsRegistering(false);
      isRegisteringRef.current = false;
    }
  }

  function placeCall() {
    if (!registered || !selectedUserId) {
      setStatus("Select an online user to call.");
      return;
    }
    socketRef.current.emit("start-call", { targetUserId: selectedUserId });
  }

  async function acceptIncoming() {
    if (!incoming) return;
    const sid = incoming.fromSocketId;
    try {
      await ensurePeerConnection(sid);
      socketRef.current.emit("accept-call", { callerSocketId: sid });
      setIncoming(null);
      setStatus("Connecting…");
    } catch {
      setStatus("Could not answer (microphone?).");
    }
  }

  function rejectIncoming() {
    if (!incoming) return;
    socketRef.current.emit("reject-call", { callerSocketId: incoming.fromSocketId });
    setIncoming(null);
    setStatus("Call declined.");
    stopRingFeedback();
  }

  function hangUp() {
    if (outgoingRinging && pendingCalleeRef.current) {
      socketRef.current.emit("cancel-outgoing", { targetSocketId: pendingCalleeRef.current });
      setOutgoingRinging(false);
      pendingCalleeRef.current = null;
      setStatus("Cancelled.");
      stopRingFeedback();
      return;
    }
    if (incoming) {
      rejectIncoming();
      return;
    }
    const to = remoteSocketRef.current;
    if (to) {
      socketRef.current.emit("call-ended", { to });
    }
    closePeerConnection();
    remoteSocketRef.current = null;
    setInCall(false);
    setStatus("Call ended.");
    stopRingFeedback();
  }

  async function fetchLogs() {
    if (myUserId.length < 3) return;
    if (!signalingUrl) {
      setStatus("Set your signaling server URL first.");
      return;
    }
    const response = await fetch(`${signalingUrl}/logs/${myUserId}`);
    const data = await response.json();
    setLogs(data.reverse());
  }

  const callTargets = onlineUsers.filter((u) => u.userId !== myUserId);
  const selectedTarget = callTargets.find((u) => u.userId === selectedUserId);

  async function handleMicChange(e) {
    const nextMic = e.target.value;
    setSelectedMicId(nextMic);
    if (!localStreamRef.current) {
      setStatus("Microphone preference saved.");
      return;
    }
    try {
      await switchMicrophone(nextMic);
      setStatus(inCall ? "Microphone changed." : "Microphone ready.");
    } catch {
      setStatus("Could not switch microphone. Check permission or device availability.");
    }
  }

  async function handleSpeakerChange(e) {
    const nextSpeaker = e.target.value;
    setSelectedSpeakerId(nextSpeaker);
    const hasRemoteAudio = Boolean(remoteAudioRef.current?.srcObject);
    if (!hasRemoteAudio) {
      setStatus("Speaker preference saved.");
      return;
    }
    try {
      await applySpeakerSelection(nextSpeaker);
      setStatus(inCall ? "Speaker output changed." : "Speaker output ready.");
    } catch {
      setStatus("Could not switch speaker output on this browser/device.");
    }
  }

  return (
    <main className="phone">
      <header className="phone-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <h1>Free Calling</h1>
            <p className="brand-sub">
              {registered ? (
                <>
                  Signed in as <strong>@{myUserId}</strong>
                </>
              ) : (
                <>Audio calling over the internet</>
              )}
            </p>
          </div>
        </div>
        {registered ? (
          <div className="header-actions">
            <button
              type="button"
              className="btn-chip"
              onClick={() => setShowAudioSettings((v) => !v)}
              aria-pressed={showAudioSettings}
            >
              Audio
            </button>
            {!hasStaticSignalingUrl() ? (
              <button
                type="button"
                className="btn-chip"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-pressed={showAdvanced}
              >
                Server
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {!registered ? (
        <section className="card setup setup-pro">
          <div className="setup-grid">
            <label>
              Display name
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Alex"
                autoComplete="name"
              />
            </label>
            <label>
              Username (call ID)
              <input
                value={myUserId}
                onChange={(e) => setMyUserId(e.target.value)}
                placeholder="e.g. alex_01"
              />
            </label>
          </div>

          {!hasStaticSignalingUrl() ? (
            <details className="details" open>
              <summary>Server</summary>
              <label>
                Signaling server URL
                <input
                  value={signalingUrl}
                  onChange={(e) => setSignalingUrl(e.target.value)}
                  placeholder="https://call-xxxx.onrender.com"
                  autoComplete="url"
                />
              </label>
            </details>
          ) : null}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={shareUserId}
              onChange={(e) => setShareUserId(e.target.checked)}
            />
            <span>Share my username with people I call</span>
          </label>

          <button type="button" onClick={doRegister} className="btn-primary" disabled={isRegistering}>
            {isRegistering ? "Connecting…" : "Continue"}
          </button>
          <p className="hint hint-tight">
            Tip: share your username. Friends can call you when you’re online in this app.
          </p>
        </section>
      ) : (
        <>
          <section className="card online-card fade-in">
            <div className="card-head">
              <h2 className="logs-title">Contacts online</h2>
              <span className="badge">{callTargets.length}</span>
            </div>
            <div className="select-wrap">
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="select-user"
              >
                <option value="">Select a contact</option>
                {callTargets.map((u) => (
                  <option key={u.userId} value={u.userId}>
                    {u.displayName} (@{u.userId})
                  </option>
                ))}
              </select>
              {selectedTarget ? (
                <p className="subtle">
                  Calling <strong>{selectedTarget.displayName}</strong> (@{selectedTarget.userId})
                </p>
              ) : (
                <p className="subtle">Pick someone online to place a call.</p>
              )}
            </div>
          </section>

          {incoming ? (
            <section className="card incoming-banner pop-in">
              <div className="incoming-avatar-wrap">
                <div className="incoming-avatar-ripple" />
                <div className="incoming-avatar-ripple delayed" />
                <div className="incoming-avatar">{incoming.fromName?.[0]?.toUpperCase() ?? "U"}</div>
              </div>
              <p>
                <strong>{incoming.callerLabel ?? `${incoming.fromName} (@${incoming.fromUserId})`}</strong>
              </p>
              <div className="row incoming-actions">
                <button type="button" className="btn-decline" onClick={rejectIncoming}>
                  Decline
                </button>
                <button type="button" className="btn-answer" onClick={acceptIncoming}>
                  Answer
                </button>
              </div>
            </section>
          ) : null}

          <section className="card call-panel slide-up">
            <div className="call-bar">
              <button
                type="button"
                className={`btn-call ${outgoingRinging ? "pulse" : ""}`}
                onClick={placeCall}
                disabled={outgoingRinging || inCall}
              >
                {outgoingRinging ? "Ringing…" : "Call"}
              </button>
              <button
                type="button"
                className={`btn-hangup ${incoming ? "pulse" : ""}`}
                onClick={hangUp}
              >
                End
              </button>
            </div>
            <p className="subtle call-hint">
              {inCall
                ? "You are in a live call."
                : outgoingRinging
                  ? "Waiting for the other user to answer."
                  : "Start a call or wait for incoming."}
            </p>
          </section>

          {inCall ? (
            <section className="card fade-in">
              <div className="card-head">
                <h2 className="logs-title">In-call controls</h2>
                <div className="call-badges">
                  <span className="badge">Live</span>
                  <span className="timer-pill">{formatDuration(callElapsedSec)}</span>
                </div>
              </div>
              <div className="in-call-actions">
                <button
                  type="button"
                  className={`btn-chip ${isMuted ? "chip-warn" : ""}`}
                  onClick={toggleMute}
                >
                  {isMuted ? "Unmute" : "Mute"}
                </button>
                <button
                  type="button"
                  className={`btn-chip ${isOnHold ? "chip-warn" : ""}`}
                  onClick={toggleHold}
                >
                  {isOnHold ? "Resume" : "Hold"}
                </button>
                <button
                  type="button"
                  className={`btn-chip ${isSharingSystemAudio ? "chip-on" : ""}`}
                  onClick={() => (isSharingSystemAudio ? stopSystemAudioShare() : startSystemAudioShare())}
                  disabled={isOnHold}
                  title={isOnHold ? "Resume call to share system audio" : undefined}
                >
                  {isSharingSystemAudio ? "Stop system audio" : "Share system audio"}
                </button>
              </div>
              <p className="subtle subtle-tight">
                Mute stops your outgoing audio. Hold pauses sending and mutes the remote audio locally.
              </p>
            </section>
          ) : null}

          {showAdvanced && !hasStaticSignalingUrl() ? (
            <section className="card fade-in">
              <div className="card-head">
                <h2 className="logs-title">Server</h2>
                <span className="badge">API</span>
              </div>
              <label className="audio-device-label">
                Signaling server URL
                <input
                  className="text-input"
                  value={signalingUrl}
                  onChange={(e) => setSignalingUrl(e.target.value)}
                  placeholder="https://call-xxxx.onrender.com"
                  autoComplete="url"
                />
              </label>
              <p className="subtle">
                Changing this affects login/calls. It’s saved on this device for next launches.
              </p>
            </section>
          ) : null}

          {showAudioSettings ? (
            <section className="card audio-card fade-in">
              <div className="card-head">
                <h2 className="logs-title">Audio</h2>
                <span className="badge">Devices</span>
              </div>
              <label className="audio-device-label">
                Microphone
                <select value={selectedMicId} onChange={handleMicChange} className="select-user">
                  <option value="">System default microphone</option>
                  {audioInputs.length === 0 ? <option value="">No microphone detected</option> : null}
                  {audioInputs.map((device, index) => (
                    <option key={device.deviceId || `mic-${index}`} value={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="audio-device-label">
                Speaker
                <select value={selectedSpeakerId} onChange={handleSpeakerChange} className="select-user">
                  <option value="">System default speaker</option>
                  {audioOutputs.length === 0 ? <option value="">No speaker output detected</option> : null}
                  {audioOutputs.map((device, index) => (
                    <option key={device.deviceId || `speaker-${index}`} value={device.deviceId}>
                      {device.label || `Speaker ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <p className="subtle">
                Speaker switching depends on browser support. Microphone switching works best once media is active.
              </p>
            </section>
          ) : null}

          <p className={`status ${inCall ? "status-live" : ""}`}>{status}</p>
          <p className="conn-state">Connection: {connectionState}</p>

          <section className="card logs-card fade-in">
            <h2 className="logs-title">Recent activity</h2>
            <button type="button" className="btn-ghost" onClick={fetchLogs}>
              Refresh
            </button>
            <ul className="logs">
              {logs.length === 0 ? <li>No entries yet.</li> : null}
              {logs.map((log) => (
                <li key={log.id}>
                  {new Date(log.at).toLocaleString()} — {log.type}
                  {log.from ? ` from ${log.from}` : ""}
                  {log.to ? ` to ${log.to}` : ""}
                  {log.with ? ` with ${log.with}` : ""}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <audio ref={localAudioRef} autoPlay muted playsInline />
      <audio ref={remoteAudioRef} autoPlay playsInline />
    </main>
  );
}
