import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "http://localhost:4000";
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

const RTC_CONFIG = { iceServers: ICE_SERVERS, iceCandidatePoolSize: 10 };

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

  const [logs, setLogs] = useState([]);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const localAudioRef = useRef(null);

  const remoteSocketRef = useRef(null);
  const pendingCalleeRef = useRef(null);

  useEffect(() => {
    const socket = io(SIGNALING_URL, { autoConnect: false });
    socketRef.current = socket;

    socket.on("connect_error", () => setStatus("Cannot reach server. Start backend on :4000"));

    socket.on("registered", ({ userId }) => {
      setRegistered(true);
      setMyUserId(userId);
      setStatus("Ready. Select an online user and tap call.");
    });

    socket.on("online-users", (users) => {
      setOnlineUsers(users);
      setSelectedUserId((current) =>
        users.some((u) => u.userId === current && u.userId !== myUserId) ? current : ""
      );
    });

    socket.on("register-failed", () =>
      setStatus("Invalid username. Use at least 3 chars: letters, numbers, _, -, .")
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
    });

    socket.on("incoming-call", ({ fromUserId, fromName, callerLabel, fromSocketId }) => {
      setIncoming({ fromUserId, fromName, callerLabel, fromSocketId });
      setStatus(`Incoming call from ${callerLabel ?? `${fromName} (@${fromUserId})`}`);
    });

    socket.on("incoming-cancelled", () => {
      setIncoming(null);
      setStatus("Missed / cancelled call.");
    });

    socket.on("remote-answered", async ({ calleeSocketId }) => {
      remoteSocketRef.current = calleeSocketId;
      setOutgoingRinging(false);
      setStatus("Connecting…");
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
    });

    socket.on("webrtc-answer", async ({ sdp }) => {
      await peerConnectionRef.current?.setRemoteDescription(sdp);
      setStatus("In call");
      setInCall(true);
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
    });

    return () => {
      socket.disconnect();
      cleanupAllMedia();
    };
  }, []);

  async function getLocalMedia() {
    if (!localStreamRef.current) {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = localStreamRef.current;
      }
    }
    return localStreamRef.current;
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

  function cleanupAllMedia() {
    closePeerConnection();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
  }

  async function doRegister() {
    const userId = myUserId.trim().toLowerCase();
    if (!displayName.trim() || userId.length < 3) {
      setStatus("Enter name and username (at least 3 chars).");
      return;
    }
    try {
      await getLocalMedia();
      socketRef.current.connect();
      socketRef.current.emit("register", {
        userId,
        displayName: displayName.trim(),
        shareUserId
      });
    } catch {
      setStatus("Microphone permission is required for calls.");
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
  }

  function hangUp() {
    if (outgoingRinging && pendingCalleeRef.current) {
      socketRef.current.emit("cancel-outgoing", { targetSocketId: pendingCalleeRef.current });
      setOutgoingRinging(false);
      pendingCalleeRef.current = null;
      setStatus("Cancelled.");
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
  }

  async function fetchLogs() {
    if (myUserId.length < 3) return;
    const response = await fetch(`${SIGNALING_URL}/logs/${myUserId}`);
    const data = await response.json();
    setLogs(data.reverse());
  }

  const callTargets = onlineUsers.filter((u) => u.userId !== myUserId);

  return (
    <main className="phone">
      <header className="phone-header">
        <h1>Internet Calls</h1>
        {registered ? (
          <p className="my-line">
            You are: <strong>@{myUserId}</strong>
          </p>
        ) : null}
      </header>

      {!registered ? (
        <section className="card setup">
          <label>
            Your name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Alex"
              autoComplete="name"
            />
          </label>
          <label>
            Username (your call ID)
            <input
              value={myUserId}
              onChange={(e) => setMyUserId(e.target.value)}
              placeholder="e.g. alex_01"
            />
          </label>
          <p className="hint">Share your username with friends. They can call you when you are online in this app.</p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={shareUserId}
              onChange={(e) => setShareUserId(e.target.checked)}
            />
            <span>Show my username to people I call</span>
          </label>
          <button type="button" onClick={doRegister}>
            Continue
          </button>
        </section>
      ) : (
        <>
          <section className="card online-card fade-in">
            <h2 className="logs-title">Online users</h2>
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
          </section>

          {incoming ? (
            <section className="card incoming-banner pop-in">
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

          <section className="call-bar slide-up">
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
          </section>

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
