// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/*
  Final App.jsx — GreenMiles
  - Splash screen
  - Logout in Profile
  - Profile fields: nama, ttl, email, phone
  - Emission factors moved to About
  - Export/Import localStorage in About to sync origins
  - Track requires evidence before Start; preview cleared on new recording
  - Snap-to-road via OSRM (best effort)
  - Emission chart removed from Dashboard
  - Bottom nav for mobile
*/

const BASE_KEY = "greenmiles_full_demo_v1";
const USERS_KEY = "greenmiles_users_v1";

const CO2_FACTORS_G_PER_KM = { walk: 0, bike: 0, bus: 70, krl: 70, mrt: 65, motorcycle: 100, car: 150 };
const MODE_LABELS = { walk: "Jalan Kaki", bike: "Sepeda", bus: "Bus", krl: "KRL/Commuter", mrt: "MRT", motorcycle: "Motor", car: "Mobil" };
const POINTS_PER_KM = { walk: 10, bike: 8, bus: 5, krl: 5, mrt: 5, motorcycle: 0, car: 0 };

const AUTO_SAVE_MIN_METERS = 30;
const SUSPICIOUS_SPEED_KMH = 20;

/* ---------- utils ---------- */
function km(n) { return Number(n || 0); }
function fmt(n) { return new Intl.NumberFormat("id-ID").format(Math.round(n)); }
function todayISO() { return new Date().toISOString().split("T")[0]; }
function getWeekIndex(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
function getMonthIndex(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}`; }

/* ---------- geometry ---------- */
function toRad(v) { return (v * Math.PI) / 180; }
function toDeg(v) { return (v * 180) / Math.PI; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function calcRouteDistance(route) {
  if (!route || route.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < route.length; i++) total += haversineKm(route[i-1].lat || route[i-1][1], route[i-1].lng || route[i-1][0], route[i].lat || route[i][1], route[i].lng || route[i][0]);
  return total;
}
function destPoint(lat, lon, bearingRad, distanceKm) {
  const R = 6371;
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const d = distanceKm / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearingRad));
  const lon2 = lon1 + Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [toDeg(lat2), toDeg(lon2)];
}

/* ---------- storage ---------- */
function loadUsers() { try { const raw = localStorage.getItem(USERS_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
function saveUsers(users) { try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch {} }

function loadStateForUser(username) {
  try {
    if (!username) return null;
    const key = `${BASE_KEY}_${username}`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { console.warn("loadStateForUser err", e); return null; }
}
function saveStateForUser(state, username) { try { if (!username) return; localStorage.setItem(`${BASE_KEY}_${username}`, JSON.stringify(state)); } catch (e) { console.warn("saveStateForUser err", e); } }

/* ---------- Leaflet lazy load ---------- */
let LeafletLibs = { MapContainer: null, TileLayer: null, Marker: null, Polyline: null, Popup: null, useMap: null };
let L = null;
async function ensureLeaflet() {
  if (!LeafletLibs.MapContainer) {
    try {
      const rl = await import("react-leaflet");
      const leaflet = await import("leaflet");
      LeafletLibs = {
        MapContainer: rl.MapContainer,
        TileLayer: rl.TileLayer,
        Marker: rl.Marker,
        Polyline: rl.Polyline,
        Popup: rl.Popup,
        useMap: rl.useMap,
      };
      L = leaflet.default || leaflet;
      if (!document.getElementById("leaflet-css")) {
        const link = document.createElement("link");
        link.id = "leaflet-css";
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      const iconRetinaUrl = "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png";
      const iconUrl = "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png";
      const shadowUrl = "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png";
      L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });
    } catch (e) { console.warn("Leaflet lazy import failed", e); }
  }
}

/* ---------- OSRM helpers (snap-to-road best-effort) ---------- */
function normalizeKmForDummy(kmVal) {
  let k = Number(kmVal || 0);
  if (k > 100) k = k / 1000;
  if (k < 0.05) k = Math.max(0.05, k || 0.2);
  if (k > 50) k = 50;
  return Number(k.toFixed(3));
}
function generateSimplePath(centerLat = -6.2, centerLng = 106.816666, targetKm = 0.5, points = 40) {
  const t = normalizeKmForDummy(targetKm);
  const half = Math.max(0.02, t / 2);
  const bearing = Math.random() * Math.PI * 2;
  const start = destPoint(centerLat, centerLng, bearing + Math.PI, half);
  const end = destPoint(centerLat, centerLng, bearing, half);
  const n = Math.max(8, points);
  const coords = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    const jitterScale = Math.min(0.00006, t * 0.00002);
    const lat = start[0] + (end[0] - start[0]) * frac + (Math.random() - 0.5) * jitterScale;
    const lon = start[1] + (end[1] - start[1]) * frac + (Math.random() - 0.5) * jitterScale;
    coords.push([parseFloat(lon.toFixed(6)), parseFloat(lat.toFixed(6))]);
  }
  return coords;
}
function modeToOsrmProfile(mode) {
  if (!mode) return "driving";
  if (mode === "walk") return "foot";
  if (mode === "bike") return "bicycle";
  return "driving";
}
async function fetchRouteViaOSRM(startLat, startLng, endLat, endLng, profile = "driving") {
  try {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("OSRM fetch failed: " + resp.status);
    const j = await resp.json();
    if (j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates) {
      return j.routes[0].geometry.coordinates;
    }
    return null;
  } catch (e) { console.warn("OSRM route fetch error:", e); return null; }
}
async function snapToRoads(coords, profile = "driving") {
  if (!coords || coords.length < 2) return coords;
  try {
    const out = [];
    const N = coords.length;
    const maxSeg = 12;
    const step = Math.max(2, Math.floor(N / Math.ceil(N / maxSeg)));
    for (let i = 0; i < N - 1; i += step) {
      const j = Math.min(N - 1, i + step);
      const a = coords[i], b = coords[j];
      const os = await fetchRouteViaOSRM(a[1], a[0], b[1], b[0], profile);
      if (os && os.length) {
        if (out.length === 0) {
          os.forEach(c => out.push([parseFloat(c[0].toFixed(6)), parseFloat(c[1].toFixed(6))]));
        } else {
          os.forEach((c, idx) => {
            const last = out[out.length - 1];
            const isSame = last && Math.abs(last[0] - c[0]) < 1e-6 && Math.abs(last[1] - c[1]) < 1e-6;
            if (idx === 0 && isSame) return;
            out.push([parseFloat(c[0].toFixed(6)), parseFloat(c[1].toFixed(6))]);
          });
        }
      } else {
        const len = j - i;
        for (let s = 0; s <= len; s++) {
          const frac = s / Math.max(1, len);
          const lng = a[0] + (b[0] - a[0]) * frac;
          const lat = a[1] + (b[1] - a[1]) * frac;
          const last = out[out.length - 1];
          if (!last || Math.abs(last[0] - lng) > 1e-6 || Math.abs(last[1] - lat) > 1e-6) out.push([parseFloat(lng.toFixed(6)), parseFloat(lat.toFixed(6))]);
        }
      }
    }
    return out.length >= 2 ? out : coords;
  } catch (e) {
    console.warn("snapToRoads error", e);
    return coords;
  }
}

/* ---------- File reader ---------- */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = (e) => reject(e);
    fr.readAsDataURL(file);
  });
}

/* ---------- small CSS injection ---------- */
function ensureModalCssOnce() {
  if (typeof document === "undefined") return;
  if (document.getElementById("gm-modal-css")) return;
  const s = document.createElement("style");
  s.id = "gm-modal-css";
  s.innerHTML = `
    .gm-map-wrapper { position: relative; overflow: hidden; height: 100%; width: 100%; }
    .gm-map-wrapper .leaflet-container { position: relative !important; height:100% !important; width:100% !important; }
    .gm-top-header { z-index:10000 !important; position: sticky !important; top:0; }
    .content-with-bottom-nav { padding-bottom: 92px; }
    .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; z-index: 40; background: white; border-top: 1px solid rgba(14,165,233,0.06); padding:6px 8px; }
    .leaflet-interactive { vector-effect: non-scaling-stroke; }
    .gm-modal-open .leaflet-container { z-index: 0 !important; pointer-events:none !important; }
    .gm-modal-open .leaflet-container.modal-active { pointer-events:auto !important; z-index:9999 !important; }
    .btn-logout { background: linear-gradient(90deg,#ef4444,#dc2626); color: white; border-radius: 999px; padding:6px 12px; border:none; }
    .splash-screen { position: fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; background: linear-gradient(135deg,#10b981,#34d399 70%); color:white; }
  `;
  document.head.appendChild(s);
}

/* ---------- trip calc helpers ---------- */
function calcTrip({ mode, distanceKm, baselineMode = "car" }) {
  const dist = km(distanceKm);
  const factor = CO2_FACTORS_G_PER_KM[mode] ?? 0;
  const baselineFactor = CO2_FACTORS_G_PER_KM[baselineMode] ?? 150;
  const co2Gram = dist * factor;
  const baselineGram = dist * baselineFactor;
  const co2SavedGram = Math.max(0, baselineGram - co2Gram);
  const points = Math.round(dist * (POINTS_PER_KM[mode] ?? 0));
  return { co2Gram, co2SavedGram, points };
}
function recomputeTotals(trips) {
  const totals = { distanceKm: 0, co2Gram: 0, co2SavedGram: 0, points: 0 };
  (trips || []).forEach(t => {
    totals.distanceKm += Number(t.distanceKm || 0);
    totals.co2Gram += Number(t.co2Gram || 0);
    totals.co2SavedGram += Number(t.co2SavedGram || 0);
    totals.points += Number(t.points || 0);
  });
  return totals;
}

/* ---------- simple smoothing ---------- */
function filterAndSmoothGps(rawPoints) {
  if (!rawPoints || rawPoints.length < 2) return rawPoints || [];
  const out = [];
  let last = null;
  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    if (!last) { out.push(p); last = p; continue; }
    const dist = haversineKm(last.lat, last.lng, p.lat, p.lng);
    const dt = Math.max(1, (p.ts - last.ts) / 1000);
    const speedKmh = (dist / (dt / 3600));
    if (dist * 1000 > 200 && speedKmh > 200) continue; // filter crazy jump
    if (dist * 1000 < 1) { out.push(p); last = p; continue; }
    out.push(p);
    last = p;
  }
  if (out.length >= 3) {
    const sm = [];
    for (let i = 0; i < out.length; i++) {
      const win = [out[Math.max(0, i-1)], out[i], out[Math.min(out.length-1, i+1)]];
      const lat = win.reduce((a,b)=>a+(b.lat||0),0)/win.length;
      const lng = win.reduce((a,b)=>a+(b.lng||0),0)/win.length;
      const ts = win[1].ts;
      sm.push({ lat, lng, ts });
    }
    return sm;
  }
  return out;
}

/* ---------- seed states ---------- */
function makeSeededAikoState() {
  const centerLat = -6.200000;
  const centerLng = 106.816666;
  const tripsBase = [
    { id: "t-walk-1", date: "2025-08-28", mode: "walk", distanceKm: 3.2, durationMin: 40, note: "Jalan pagi" },
    { id: "t-bike-1", date: "2025-08-28", mode: "bike", distanceKm: 5.5, durationMin: 20, note: "Sepeda ke kantor" },
    { id: "t-bus-1",  date: "2025-08-28", mode: "bus",  distanceKm: 10.1, durationMin: 30, note: "Naik bus trans" },
  ];
  const tripsWithGeo = tripsBase.map(t => {
    const coords = generateSimplePath(centerLat, centerLng, t.distanceKm, Math.max(24, Math.round(t.distanceKm * 12)));
    const { co2Gram, co2SavedGram, points } = calcTrip({ mode: t.mode, distanceKm: t.distanceKm });
    return { ...t, routeGeoJSON: { type: "Feature", properties: { mode: t.mode, generated: true }, geometry: { type: "LineString", coordinates: coords } }, co2Gram, co2SavedGram, points };
  });
  const totals = recomputeTotals(tripsWithGeo);
  return {
    user: { id: "aiko", name: "Aiko", tier: "Bronze", profile: { nama: "Aiko", ttl: "", email: "", phone: "" } },
    trips: tripsWithGeo,
    totals, challenges: { dailyWalkKm: 3, weeklyTransitCount: 0, monthlyReductionPct: 0, lastDaily: todayISO() },
    rewards: [{ id:"r1", name:"Voucher KRL Rp10.000", cost:500, stock:10 },{ id:"r2", name:"Diskon Kopi 20%", cost:400, stock:5 }],
    leaderboard: [{ id:"u1", name:"Karin", points:3200 },{ id:"u2", name:"Rizky", points:2800 },{ id:"me", name:"Aiko", points: totals.points }],
    models: [], requests: [], redeemHistory: [],
  };
}
function makeSeededHasanulState() {
  return {
    user: { id: "hasanul", name: "Hasanul", tier: "Gold", profile: { nama: "Hasanul", ttl: "", email: "", phone: "" } },
    trips: [],
    totals: { distanceKm: 0, co2Gram: 0, co2SavedGram: 0, points: 120 },
    challenges: { dailyWalkKm:0, weeklyTransitCount:0, monthlyReductionPct:0, lastDaily: todayISO() },
    rewards: [{ id:"r1", name:"Voucher KRL Rp10.000", cost:500, stock:10 }],
    leaderboard: [{ id:"u1", name:"Karin", points:3200 },{ id:"u2", name:"Rizky", points:2800 },{ id:"me", name:"Hasanul", points:120 }],
    models: [], requests: [], redeemHistory: [],
  };
}

/* ---------- permission helper ---------- */
async function requestLocationPermission() {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return { ok: false, msg: "Perangkat tidak mendukung lokasi (GPS)." };
  }
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: "geolocation" });
      if (status.state === "denied") {
        return { ok: false, msg: "Izin lokasi telah diblokir. Buka pengaturan browser / situs dan izinkan akses lokasi." };
      }
    }
  } catch (e) { /* ignore */ }
  return new Promise((resolve) => {
    let called = false;
    const onSucc = () => { if (!called) { called = true; resolve({ ok: true }); } };
    const onErr = (err) => {
      if (called) return;
      called = true;
      if (err && err.code === 1) resolve({ ok: false, msg: "Izin lokasi telah diblokir. Buka pengaturan browser / situs dan izinkan akses lokasi." });
      else if (err && err.code === 3) resolve({ ok: false, msg: "Timeout saat meminta lokasi. Coba lagi." });
      else resolve({ ok: false, msg: err?.message || "Izin lokasi ditolak atau tidak tersedia." });
    };
    navigator.geolocation.getCurrentPosition(onSucc, onErr, { enableHighAccuracy: true, timeout: 8000 });
    setTimeout(()=>{ if(!called){ called=true; resolve({ ok:false, msg:"Timeout saat meminta lokasi. Coba lagi." }); } }, 9000);
  });
}

/* ---------- Splash ---------- */
function SplashScreen({ onFinish }) {
  useEffect(() => {
    const t = setTimeout(() => onFinish && onFinish(), 1800);
    return () => clearTimeout(t);
  }, [onFinish]);
  return (
    <div className="splash-screen" onClick={() => onFinish && onFinish()}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:36, fontWeight:700}}>GreenMiles</div>
        <div style={{opacity:0.9, marginTop:8}}>Aplikasi mobilitas ramah lingkungan</div>
        <div style={{marginTop:12}}><button style={{padding:"8px 14px", borderRadius:999, background:"white", color:"#059669"}} onClick={() => onFinish && onFinish()}>Mulai</button></div>
      </div>
    </div>
  );
}

/* ---------- App root ---------- */
export default function App() {
  ensureModalCssOnce();

  useEffect(() => {
    try {
      const users = loadUsers();
      if (!users["aiko"]) users["aiko"] = { password: "123", name: "Aiko" };
      if (!users["hasanul"]) users["hasanul"] = { password: "hasan123", name: "Hasanul" };
      saveUsers(users);
      if (!localStorage.getItem(`${BASE_KEY}_aiko`)) saveStateForUser(makeSeededAikoState(), "aiko");
      if (!localStorage.getItem(`${BASE_KEY}_hasanul`)) saveStateForUser(makeSeededHasanulState(), "hasanul");
    } catch (e) { console.warn("seed err", e); }
  }, []);

  const [showSplash, setShowSplash] = useState(true);
  const [sessionUser, setSessionUser] = useState(() => { try { const raw = localStorage.getItem("gm_session"); return raw ? JSON.parse(raw).username : null; } catch { return null; } });
  const [state, setState] = useState(() => { try { const s = loadStateForUser(sessionUser); return s || makeSeededAikoState(); } catch { return makeSeededAikoState(); } });
  const [activeTab, setActiveTab] = useState("dashboard");
  const [leafletReady, setLeafletReady] = useState(false);
  const [tripDetail, setTripDetail] = useState(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.innerWidth <= 640 : false);

  useEffect(() => {
    const st = loadStateForUser(sessionUser);
    if (st) setState(st);
  }, [sessionUser]);

  useEffect(() => { if (sessionUser) saveStateForUser(state, sessionUser); }, [state, sessionUser]);

  useEffect(() => {
    (async () => {
      if (["track", "history", "dashboard"].includes(activeTab)) {
        await ensureLeaflet();
        setLeafletReady(true);
      }
    })();
  }, [activeTab]);

  useEffect(() => { const onResize = () => setIsMobile(window.innerWidth <= 640); window.addEventListener("resize", onResize); return () => window.removeEventListener("resize", onResize); }, []);

  const addTrip = (trip) => {
    const { co2Gram, co2SavedGram, points } = calcTrip(trip);
    const t = {
      id: crypto.randomUUID(),
      date: todayISO(),
      durationMin: trip.durationMin || Math.round(trip.distanceKm * 2.5),
      ...trip,
      distanceKm: (typeof trip.distanceKm === "number") ? trip.distanceKm : Number(trip.distanceKm || 0),
      co2Gram, co2SavedGram, points
    };
    setState(s => {
      const newTrips = [t, ...(s.trips||[])];
      const totals = recomputeTotals(newTrips);
      const leaderboard = (s.leaderboard||[]).map(u => u.id === "me" ? { ...u, name: s.user.name || "Kamu", points: totals.points } : u);
      const newState = { ...s, trips: newTrips, totals, leaderboard };
      if (sessionUser) saveStateForUser(newState, sessionUser);
      return newState;
    });
  };

  const redeem = (rewardId) => {
    setState(s => {
      const r = s.rewards.find(x => x.id === rewardId);
      if (!r || r.stock <= 0 || (s.totals.points || 0) < r.cost) return s;
      const rewards = s.rewards.map(x => x.id === rewardId ? { ...x, stock: x.stock - 1 } : x);
      const totals = { ...s.totals, points: (s.totals.points||0) - r.cost };
      const leaderboard = (s.leaderboard||[]).map(u => u.id === "me" ? { ...u, points: totals.points } : u);
      const redeemHistory = [{ id: crypto.randomUUID(), rewardId: r.id, name: r.name, date: new Date().toISOString() }, ...(s.redeemHistory||[])];
      const newState = { ...s, rewards, totals, leaderboard, redeemHistory };
      if (sessionUser) saveStateForUser(newState, sessionUser);
      return newState;
    });
  };

  const removeEvidenceForTrip = (tripId) => {
    setState(prev => {
      const trips = (prev.trips || []).map(t => t.id === tripId ? { ...t, evidence: null } : t);
      const totals = recomputeTotals(trips);
      const leaderboard = (prev.leaderboard || []).map(u => u.id === "me" ? { ...u, points: totals.points } : u);
      const newState = { ...prev, trips, totals, leaderboard };
      if (sessionUser) saveStateForUser(newState, sessionUser);
      return newState;
    });
    if (tripDetail && tripDetail.id === tripId) setTripDetail(prev => ({ ...prev, evidence: null }));
  };

  const handleLogout = () => { try { window.dispatchEvent(new Event("gm_logout")); } catch {} localStorage.removeItem("gm_session"); setSessionUser(null); setState(makeSeededAikoState()); setActiveTab("dashboard"); };

  const openTripDetail = async (trip) => {
    setTripDetail(trip);
    await ensureLeaflet();
    setLeafletReady(true);
    try {
      const rg = trip.routeGeoJSON && trip.routeGeoJSON.geometry && trip.routeGeoJSON.geometry.coordinates;
      if (rg && rg.length >= 2 && !trip.routeGeoJSON.properties?.snapped) {
        const profile = modeToOsrmProfile(trip.mode);
        const snapped = await snapToRoads(rg, profile);
        if (snapped && snapped.length >= 2) {
          setState(prev => {
            const trips = (prev.trips || []).map(t => t.id === trip.id ? { ...t, routeGeoJSON: { ...t.routeGeoJSON, geometry: { ...t.routeGeoJSON.geometry, coordinates: snapped }, properties: { ...t.routeGeoJSON.properties, snapped: true } } } : t);
            const newState = { ...prev, trips };
            if (sessionUser) saveStateForUser(newState, sessionUser);
            return newState;
          });
          setTripDetail(prev => ({ ...prev, routeGeoJSON: { ...prev.routeGeoJSON, geometry: { ...prev.routeGeoJSON.geometry, coordinates: snapped }, properties: { ...prev.routeGeoJSON.properties, snapped: true } } }));
        }
      }
    } catch (e) { console.warn("snap on open error", e); }
  };

  const closeTripDetail = () => setTripDetail(null);

  if (showSplash) return <SplashScreen onFinish={() => setShowSplash(false)} />;

  if (!sessionUser) {
    return (
      <AuthScreen
        onLogin={({ username, password }) => {
          const users = loadUsers();
          if (!users[username]) return alert("User tidak ditemukan");
          if (users[username].password !== password) return alert("Password salah");
          localStorage.setItem("gm_session", JSON.stringify({ username }));
          setSessionUser(username);
          const st = loadStateForUser(username) || makeSeededAikoState();
          setState(st);
        }}
        onRegister={({ username, password, name }) => {
          const users = loadUsers();
          if (users[username]) return alert("Username sudah ada");
          users[username] = { password, name: name || username };
          saveUsers(users);
          const template = {
            user: { id: username, name: name || username, tier: "Bronze", profile: { nama: name || username, ttl: "", email: "", phone: "" } },
            trips: [], totals: { distanceKm:0, co2Gram:0, co2SavedGram:0, points:0 },
            challenges: { dailyWalkKm:0, weeklyTransitCount:0, monthlyReductionPct:0, lastDaily: todayISO() },
            rewards: [{ id:"r1", name:"Voucher KRL Rp10.000", cost:500, stock:10 }],
            leaderboard: [{ id:"u1", name:"Karin", points:3200 },{ id:"u2", name:"Rizky", points:2800 },{ id:"me", name: name || "Kamu", points:0 }],
            models: [], requests: [], redeemHistory: [],
          };
          saveStateForUser(template, username);
          alert("Registrasi berhasil. Silakan login.");
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-emerald-50 to-white text-slate-800">
      <HeaderSimple state={state} />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">
        <div className={`flex gap-6 ${isMobile ? "flex-col" : ""}`}>
          {!isMobile && <aside style={{ minWidth: 220 }}><Sidebar state={state} active={activeTab} onChange={setActiveTab} /></aside>}
          <section className="flex-1">
            {activeTab === "dashboard" && <Dashboard state={state} openTripDetail={openTripDetail} leafletReady={leafletReady} />}
            {activeTab === "track" && <Track onAddTrip={addTrip} ensureLeaflet={ensureLeaflet} />}
            {activeTab === "history" && <History state={state} openTripDetail={openTripDetail} ensureLeaflet={ensureLeaflet} leafletReady={leafletReady} />}
            {activeTab === "challenges" && <Challenges state={state} />}
            {activeTab === "rewards" && <Rewards state={state} onRedeem={redeem} />}
            {activeTab === "leaderboard" && <Leaderboard state={state} />}
            {activeTab === "profile" && <Profile state={state} setState={setState} sessionUser={sessionUser} onLogout={handleLogout} />}
            {activeTab === "about" && <About state={state} setState={setState} sessionUser={sessionUser} />}
          </section>
        </div>
      </main>

      {isMobile && <BottomNav active={activeTab} onChange={setActiveTab} />}

      <footer className="hidden sm:block max-w-6xl mx-auto w-full px-4 py-4 text-xs text-slate-500">*Nilai emisi & poin hanya contoh untuk demo. Integrasi real-world perlu verifikasi sumber resmi.</footer>

      {tripDetail && <TripDetailModal trip={tripDetail} onClose={closeTripDetail} removeEvidenceForTrip={removeEvidenceForTrip} leafletReady={leafletReady} />}
    </div>
  );
}

/* ---------- UI components (Auth, Header, Sidebar, Nav, Cards) ---------- */

function AuthScreen({ onLogin, onRegister }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [waiting, setWaiting] = useState(false);

  const submit = async (e) => {
    e && e.preventDefault();
    setWaiting(true);
    if (mode === "login") {
      if (!username.trim() || !password) { setWaiting(false); return alert("Isi username & password"); }
      await onLogin({ username: username.trim(), password });
      setWaiting(false);
      return;
    }
    if (!username.trim() || !password) { setWaiting(false); return alert("Isi username & password"); }
    onRegister({ username: username.trim(), password, name: name.trim() || username.trim() });
    setWaiting(false);
    setMode("login"); setPassword("");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow p-6">
        <h2 className="text-xl font-semibold mb-4">GreenMiles — {mode === "login" ? "Login" : "Register"}</h2>
        <form onSubmit={submit} className="grid gap-3">
          {mode === "register" && <input className="border rounded-xl px-3 py-2" placeholder="Nama (tampil)" value={name} onChange={e=>setName(e.target.value)} />}
          <input className="border rounded-xl px-3 py-2" placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} />
          <input className="border rounded-xl px-3 py-2" type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} />
          <div className="flex gap-2">
            <button type="submit" disabled={waiting} className="rounded-xl bg-emerald-600 text-white px-4 py-2">{waiting ? "Memproses..." : (mode==="login" ? "Login" : "Register")}</button>
            <button type="button" onClick={()=>setMode(mode==="login"?"register":"login")} className="rounded-xl border px-4 py-2">register</button>
          </div>
        </form>
        <div className="text-xs text-slate-500 mt-3">Demo only: akun disimpan di browser. Untuk produksi gunakan backend + auth.</div>
        <div className="text-xs text-slate-500 mt-2"><strong>Demo account:</strong> username <code>hasanul</code> / password <code>hasan123</code> • username <code>aiko</code> / password <code>123</code></div>
      </div>
    </div>
  );
}

function HeaderSimple({ state }) {
  return (
    <header className="gm-top-header bg-white/90 backdrop-blur border-b border-emerald-100">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white font-bold">G</div>
          <div>
            <div className="text-lg font-semibold">GreenMiles</div>
            <div className="text-xs text-slate-500 -mt-1">Gamifikasi mobilitas ramah lingkungan</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-100 text-amber-800">
            <span style={{fontSize:14}}>🥉 Bronze</span>
          </div>
          <div className="text-sm text-slate-600">Poin: <strong style={{marginLeft:6}}>{fmt(state.totals.points || 0)}</strong></div>
          <div className="text-sm text-slate-600 pl-3 border-l ml-2">{state.user.name}</div>
        </div>
      </div>
    </header>
  );
}

function Sidebar({ state, active, onChange }) {
  const tabs = [
    { k: "dashboard", t: "Dashboard" },
    { k: "track", t: "Tracking" },
    { k: "history", t: "Riwayat" },
    { k: "challenges", t: "Tantangan" },
    { k: "rewards", t: "Reward" },
    { k: "leaderboard", t: "Peringkat" },
    { k: "profile", t: "Profil" },
    { k: "about", t: "Tentang" },
  ];
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="mb-4">
        <div className="text-sm font-semibold">GreenMiles</div>
        <div className="text-xs text-slate-500">Aplikasi hijau</div>
      </div>
      <nav className="flex flex-col gap-2">
        {tabs.map(tab => (
          <button key={tab.k} onClick={() => onChange(tab.k)} className={`text-left rounded-xl px-3 py-2 border ${active===tab.k ? "bg-emerald-50 border-emerald-200" : "bg-white border-emerald-100"}`}>{tab.t}</button>
        ))}
      </nav>
      <div className="mt-6 rounded-xl border p-3 bg-emerald-50">
        <div className="text-sm font-medium">{state.user.name}</div>
        <div className="text-xs text-slate-600">Tier: {state.user.tier}</div>
        <div className="text-xs text-slate-600">Poin: {fmt(state.totals.points || 0)}</div>
      </div>
    </div>
  );
}

function BottomNav({ active, onChange }) {
  const tabs = [
    { key: "dashboard", label: "🏠", text: "Home" },
    { key: "track", label: "📍", text: "Track" },
    { key: "history", label: "📜", text: "Riwayat" },
    { key: "about", label: "ℹ️", text: "Tentang" },
    { key: "profile", label: "👤", text: "Profil" },
    { key: "leaderboard", label: "🏆", text: "Peringkat" },
  ];
  return (
    <nav className="bottom-nav">
      <div className="max-w-6xl mx-auto grid grid-cols-6 gap-2">
        {tabs.map(t => (
          <button key={t.key} onClick={() => onChange(t.key)} className={`flex flex-col items-center text-sm ${active === t.key ? "text-emerald-600" : "text-slate-500"}`}>
            <div className="text-xl">{t.label}</div>
            <div className="text-[11px] mt-1">{t.text}</div>
          </button>
        ))}
      </div>
    </nav>
  );
}

function Card({ title, right, children }) {
  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{title}</h3>
        {right}
      </div>
      <div>{children}</div>
    </div>
  );
}
function Stat({ label, value, sub }) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

/* ---------- Dashboard (no emissions chart) ---------- */
function displayKmRaw(n) {
  let k = Number(n || 0);
  if (isNaN(k)) k = 0;
  if (k > 100) k = k / 1000;
  return `${k.toFixed(1).replace(".", ",")} km`;
}
function Dashboard({ state, openTripDetail, leafletReady }) {
  const totalKmDisplay = displayKmRaw(state.totals.distanceKm || 0);
  const co2 = fmt((state.totals.co2Gram || 0) / 1000);
  const saved = fmt((state.totals.co2SavedGram || 0) / 1000);
  const pts = fmt(state.totals.points || 0);
  const lastTrip = (state.trips || []).length ? state.trips[0] : null;

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total Jarak" value={`${totalKmDisplay}`} />
        <Stat label="Emisi Terkumpul" value={`${co2} kg CO₂`} />
        <Stat label="Emisi Dihemat" value={`${saved} kg CO₂`} />
        <Stat label="GreenPoints" value={pts} />
      </div>

      <Card title="Ringkasan Tantangan Hari Ini" right={<small className="text-xs text-slate-500">Status cepat</small>}>
        <div className="grid sm:grid-cols-3 gap-3">
          <SmallChallengeTile state={state} />
          <SmallChallengeTile state={state} type="transit" />
          <SmallChallengeTile state={state} type="reduction" />
        </div>
      </Card>

      <div className="grid sm:grid-cols-2 gap-3">
        <Card title="Ringkasan Perjalanan Terbaru">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500"><th className="py-2">Tanggal</th><th>Moda</th><th>Jarak</th><th>Poin</th><th>Catatan</th></tr>
            </thead>
            <tbody>
              {(state.trips || []).slice(0,8).map(t => (
                <tr key={t.id} className="border-t hover:bg-emerald-50 cursor-pointer" onClick={()=>openTripDetail(t)}>
                  <td className="py-2">{t.date}</td>
                  <td>{MODE_LABELS[t.mode] || t.mode}</td>
                  <td>{displayKmRaw(t.distanceKm || 0)}</td>
                  <td>{t.points}</td>
                  <td>{t.note || "-"}</td>
                </tr>
              ))}
              {(state.trips || []).length===0 && (<tr><td colSpan={5} className="py-4 text-center text-slate-500">Belum ada perjalanan.</td></tr>)}
            </tbody>
          </table>
          <div className="text-xs text-slate-500 mt-2">Klik baris untuk melihat detail (jika ada rute, akan tampil di peta).</div>
        </Card>

        <Card title="Perjalanan Terakhir & Preview Peta">
          {lastTrip ? (
            <div className="grid gap-3">
              <div className="text-sm text-slate-600">Terakhir: {lastTrip.date} — {MODE_LABELS[lastTrip.mode]} — {displayKmRaw(lastTrip.distanceKm || 0)}</div>
              {lastTrip.routeGeoJSON ? (
                <div className="rounded-xl border overflow-hidden" style={{height: 220}}>
                  <MiniRouteMap routeGeoJSON={lastTrip.routeGeoJSON} />
                </div>
              ) : (
                <div className="h-[120px] flex items-center justify-center text-slate-500 border rounded-xl">Tidak ada peta untuk perjalanan terakhir.</div>
              )}
              <div className="text-xs text-slate-500">Mini-map ini adalah preview rute. Garis mengikuti jalur jika OSRM snap tersedia.</div>
            </div>
          ) : (
            <div className="text-sm text-slate-500">Belum ada perjalanan tersimpan.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ---------- MiniRouteMap (safe hooks order) ---------- */
function MiniRouteMap({ routeGeoJSON }) {
  const { MapContainer, TileLayer, Polyline } = LeafletLibs;
  const mapRef = useRef(null);
  const [stroke, setStroke] = useState(4);

  if (!MapContainer) return <div className="h-full w-full flex items-center justify-center text-slate-500">Memuat peta…</div>;

  const coords = (routeGeoJSON && routeGeoJSON.geometry && routeGeoJSON.geometry.coordinates) ? routeGeoJSON.geometry.coordinates.map(c => [c[1], c[0]]) : [];
  const center = coords.length ? coords[Math.floor(coords.length/2)] : [-6.2, 106.816666];

  return (
    <div className="gm-map-wrapper" style={{height: "100%", width: "100%"}}>
      <MapContainer center={center} zoom={13} style={{ height: "100%", width: "100%" }} whenCreated={(map) => {
        mapRef.current = map;
        try { const bounds = L.latLngBounds(coords); map.fitBounds(bounds, { padding: [10,10] }); } catch {}
        setTimeout(()=>map.invalidateSize && map.invalidateSize(), 250);
        const updateStroke = () => { try { setStroke(Math.max(2, Math.round(map.getZoom()))); } catch {} };
        updateStroke();
        map.on("zoomend", updateStroke);
      }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
        {coords.length >= 2 && <Polyline positions={coords} pathOptions={{ color: "#10b981", weight: stroke, lineJoin: "round", smoothFactor: 1.2 }} />}
      </MapContainer>
    </div>
  );
}

/* ---------- Track (require evidence) ---------- */
function Track({ onAddTrip, ensureLeaflet }) {
  const [libsReady, setLibsReady] = useState(false);
  const [gpsSupported, setGpsSupported] = useState(typeof navigator !== "undefined" && "geolocation" in navigator);
  const watchIdRef = useRef(null);
  const [route, setRoute] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [center, setCenter] = useState({ lat: -6.2, lng: 106.816666 });
  const [mode, setMode] = useState("walk");
  const startedAtRef = useRef(null);
  const [distanceManual, setDistanceManual] = useState(0.5);
  const [durationManual, setDurationManual] = useState(10);
  const [errorMsg, setErrorMsg] = useState("");
  const [evidenceFile, setEvidenceFile] = useState(null);
  const [evidencePreview, setEvidencePreview] = useState(null);

  useEffect(()=>{ (async ()=>{ await ensureLeaflet(); setLibsReady(true); })(); },[ensureLeaflet]);

  useEffect(()=>{ if (!gpsSupported) return; navigator.geolocation.getCurrentPosition(pos=>{ const { latitude, longitude } = pos.coords; setCenter({ lat: latitude, lng: longitude }); }, ()=>{}, { enableHighAccuracy:true, timeout:8000 }); }, [gpsSupported]);

  useEffect(()=>{ const onLogout = () => { if (watchIdRef.current !== null) { try { navigator.geolocation.clearWatch(watchIdRef.current); } catch {} watchIdRef.current = null; } setIsRecording(false); setRoute([]); setEvidenceFile(null); setEvidencePreview(null); }; window.addEventListener("gm_logout", onLogout); return ()=> window.removeEventListener("gm_logout", onLogout); }, []);

  const start = async () => {
    if (!gpsSupported) { setErrorMsg("Perangkat tidak mendukung GPS."); return; }
    if (isRecording) return;
    if (!evidenceFile) { alert("Sebelum Start, unggah bukti foto atau video (wajib)."); return; }
    const perm = await requestLocationPermission();
    if (!perm.ok) { alert(perm.msg); return; }
    setErrorMsg(""); setRoute([]); startedAtRef.current = Date.now();
    const id = navigator.geolocation.watchPosition(pos => {
      const { latitude, longitude } = pos.coords;
      setRoute(prev=>[...prev, { lat: latitude, lng: longitude, ts: Date.now() }]);
      setCenter({ lat: latitude, lng: longitude });
    }, err => setErrorMsg(err.message || "Gagal akses GPS"), { enableHighAccuracy:true, maximumAge:1000, timeout:10000 });
    watchIdRef.current = id; setIsRecording(true);
  };

  async function stop() {
    if (watchIdRef.current !== null) { try { navigator.geolocation.clearWatch(watchIdRef.current); } catch {} watchIdRef.current = null; }
    setIsRecording(false);
    const filtered = filterAndSmoothGps(route);
    const distKm = calcRouteDistance(filtered);
    const durMin = startedAtRef.current ? Math.max(1, Math.round((Date.now() - startedAtRef.current) / 60000)) : durationManual;
    setDistanceManual(Number(distKm.toFixed(3))); setDurationManual(durMin);
    const minKm = AUTO_SAVE_MIN_METERS / 1000;
    if (distKm >= minKm) {
      let coords = filtered.map(p => [p.lng, p.lat]);
      const profile = modeToOsrmProfile(mode);
      const snapped = await snapToRoads(coords, profile);
      const maxSpeedKmh = computeMaxSpeedKmh(filtered);
      const suspicious = maxSpeedKmh > SUSPICIOUS_SPEED_KMH;
      const evidenceDataUrl = await readFileAsDataURL(evidenceFile);
      const trip = {
        mode, distanceKm: Number(distKm.toFixed(3)), durationMin: durMin,
        note: "Direkam GPS",
        routeGeoJSON: { type: "Feature", properties: { mode, snapped: !!snapped }, geometry: { type: "LineString", coordinates: (snapped && snapped.length>=2) ? snapped : coords } },
        evidence: evidenceDataUrl, maxSpeedKmh: Number(maxSpeedKmh.toFixed(2)), suspicious, baselineMode: "car",
      };
      onAddTrip(trip);
      setRoute([]); setEvidenceFile(null); if (evidencePreview) URL.revokeObjectURL(evidencePreview); setEvidencePreview(null); startedAtRef.current = null;
      alert("Rute tersimpan ke riwayat.");
    } else {
      alert(`Rute tersimpan secara sementara (jarak < ${AUTO_SAVE_MIN_METERS} m). Tidak disimpan ke riwayat.`);
      setRoute([]); setEvidenceFile(null); if (evidencePreview) URL.revokeObjectURL(evidencePreview); setEvidencePreview(null);
    }
  }

  function computeMaxSpeedKmh(r) {
    if (!r || r.length < 2) return 0;
    let max = 0;
    for (let i = 1; i < r.length; i++) {
      const p0 = r[i-1], p1 = r[i];
      const distKm = haversineKm(p0.lat, p0.lng, p1.lat, p1.lng);
      const dtSec = Math.max(1, (p1.ts - p0.ts) / 1000);
      const speedKmh = (distKm / (dtSec / 3600));
      if (speedKmh > max) max = speedKmh;
    }
    return max;
  }

  const manualSave = async () => {
    const trip = { mode, distanceKm: km(distanceManual), durationMin: Math.max(1, Math.round(durationManual)), note: "Manual input", baselineMode: "car" };
    onAddTrip(trip);
    setEvidenceFile(null);
    if (evidencePreview) URL.revokeObjectURL(evidencePreview);
    setEvidencePreview(null);
    alert("Perjalanan manual tersimpan.");
  };

  const distPreview = calcRouteDistance(route);
  const onEvidenceChange = (file) => {
    if (!file) { setEvidenceFile(null); if (evidencePreview) URL.revokeObjectURL(evidencePreview); setEvidencePreview(null); return; }
    setEvidenceFile(file);
    const url = URL.createObjectURL(file);
    setEvidencePreview(url);
  };

  return (
    <div className="grid gap-4">
      <Card title="Rekam Perjalanan dengan Peta (GPS)" right={<span className="text-xs text-slate-500">{gpsSupported ? "GPS ok" : "GPS tidak tersedia"}</span>}>
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="grid gap-3">
            <label className="text-sm">Bukti (foto/video) — wajib sebelum Start</label>
            <div className="flex gap-2 items-center">
              <input key={String(!!evidenceFile)} type="file" accept="image/*,video/*" capture="environment" onChange={(e)=>onEvidenceChange(e.target.files && e.target.files[0])} />
              {evidencePreview && <div className="text-xs text-slate-500">Preview siap. (Bukti disimpan lokal sebagai data URL.)</div>}
            </div>

            <label className="text-sm">Moda</label>
            <select value={mode} onChange={e=>setMode(e.target.value)} className="border rounded-xl px-3 py-2">
              {Object.keys(MODE_LABELS).map(k => <option key={k} value={k}>{MODE_LABELS[k]}</option>)}
            </select>

            <div className="flex gap-2 mt-2">
              {!isRecording ? <button onClick={start} className="rounded-xl bg-emerald-600 text-white px-4 py-2">Start</button> : <button onClick={stop} className="rounded-xl bg-rose-600 text-white px-4 py-2">Stop</button>}
              <button onClick={stop} disabled={route.length<2} className={`rounded-xl px-4 py-2 ${route.length>=2 ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"}`}>Simpan dari Rute</button>
            </div>

            <div className="rounded-2xl border p-4 bg-emerald-50">
              <div className="text-sm text-slate-600">Ringkasan Rute</div>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <Stat label="Titik" value={route.length} />
                <Stat label="Jarak (km)" value={distPreview.toFixed(3)} />
                <Stat label="Durasi (menit)" value={startedAtRef.current ? Math.max(1, Math.round((Date.now()-startedAtRef.current)/60000)) : durationManual} />
                <Stat label="Mode" value={MODE_LABELS[mode]} />
              </div>
              {errorMsg && <div className="text-xs text-rose-600 mt-2">{errorMsg}</div>}
            </div>

            <div className="rounded-2xl border p-4">
              <div className="text-sm text-slate-600 mb-2">Input manual (jika tidak pakai GPS)</div>
              <div className="grid grid-cols-2 gap-3">
                <input type="number" min="0" step="0.1" value={distanceManual} onChange={e=>setDistanceManual(Number(e.target.value))} className="border rounded-xl px-3 py-2" />
                <input type="number" min="1" step="1" value={durationManual} onChange={e=>setDurationManual(Number(e.target.value))} className="border rounded-xl px-3 py-2" />
              </div>
              <button onClick={manualSave} className="mt-3 rounded-xl bg-emerald-600 text-white px-4 py-2">Simpan (Manual)</button>
            </div>

            <div className="text-xs text-slate-500 mt-2">Keterangan: Sebelum <strong>Start</strong> Anda wajib mengunggah bukti foto/video. Setelah <strong>Stop</strong>, rute akan disimpan otomatis jika jarak ≥ {AUTO_SAVE_MIN_METERS} meter (~{(AUTO_SAVE_MIN_METERS/1000).toFixed(2)} km). Aplikasi menghitung kecepatan; bila kecepatan maksimum lebih dari {SUSPICIOUS_SPEED_KMH} km/h maka perjalanan akan diberi tanda <strong>⚠️ Suspicious</strong>.</div>
          </div>

          <div className="grid gap-3">
            <div className="rounded-2xl border overflow-hidden">
              <div className="h-[360px]">
                {libsReady ? <LiveMap center={center} route={route} /> : <div className="h-full w-full flex items-center justify-center text-slate-500">Memuat peta…</div>}
              </div>
            </div>

            <div className="rounded-2xl border p-4">
              <div className="text-sm text-slate-600">Preview Emisi & Poin (estimasi)</div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="text-sm">Jarak (km)</div><div className="text-sm">{distPreview.toFixed(3)}</div>
                <div className="text-sm">Emisi (g)</div><div className="text-sm">{Math.round(calcTrip({ mode, distanceKm: distPreview }).co2Gram)}</div>
                <div className="text-sm">Poin</div><div className="text-sm">{calcTrip({ mode, distanceKm: distPreview }).points}</div>
              </div>
            </div>

            {evidencePreview && (
              <div className="rounded-2xl border p-3">
                <div className="text-sm text-slate-600 mb-2">Preview Bukti</div>
                {evidenceFile && evidenceFile.type.startsWith("image/") ? <img src={evidencePreview} alt="evidence" className="max-h-36 object-contain" /> : <video src={evidencePreview} controls className="max-h-36" />}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

/* LiveMap */
function LiveMap({ center, route }) {
  const { MapContainer, TileLayer, Marker, Polyline } = LeafletLibs;
  const mapRef = useRef(null);
  const [stroke, setStroke] = useState(5);

  if (!MapContainer) return <div className="h-full w-full flex items-center justify-center text-slate-500">Map libs tidak siap</div>;
  const coords = (route || []).map(p => [p.lat, p.lng]);
  const centerArr = [center.lat, center.lng];

  return (
    <div className="gm-map-wrapper" style={{height: "100%", width: "100%"}}>
      <MapContainer center={centerArr} zoom={15} style={{ height: "100%", width: "100%" }} whenCreated={(map)=>{ mapRef.current = map; setTimeout(()=>map.invalidateSize && map.invalidateSize(),200); const updateStroke = () => setStroke(Math.max(2, Math.round(map.getZoom()))); updateStroke(); map.on("zoomend", updateStroke); }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
        <Marker position={centerArr} />
        {coords.length >= 2 && <Polyline positions={coords} pathOptions={{ color: "#10b981", weight: stroke, lineJoin: "round", smoothFactor: 1.2 }} />}
      </MapContainer>
    </div>
  );
}

/* TripDetailModal */
function TripDetailModal({ trip, onClose, removeEvidenceForTrip, leafletReady }) {
  const [mapReady, setMapReady] = useState(leafletReady);
  useEffect(() => { (async () => { if (!mapReady) await ensureLeaflet(); setMapReady(true); })(); }, []); // eslint-disable-line

  useEffect(() => { if (typeof document !== "undefined") document.body.classList.add("gm-modal-open"); return () => { try { document.body.classList.remove("gm-modal-open"); } catch {} }; }, []);

  return (
    <div className="fixed inset-0 bg-black/40 z-[9998] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl p-4 relative z-[9999]">
        <button onClick={onClose} className="absolute right-3 top-3 rounded-full border px-3 py-1">Tutup</button>
        <h3 className="text-lg font-semibold mb-2">Detail Perjalanan — {trip.date}</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-slate-600">Moda: <strong>{MODE_LABELS[trip.mode]}</strong></div>
            <div className="text-sm text-slate-600 mt-1">Jarak: <strong>{displayKmRaw(trip.distanceKm)}</strong></div>
            <div className="text-sm text-slate-600 mt-1">Durasi: <strong>{trip.durationMin} menit</strong></div>
            <div className="text-sm text-slate-600 mt-1">Poin: <strong>{trip.points}</strong></div>
            <div className="text-sm text-slate-600 mt-1">Emisi (g): <strong>{Math.round(trip.co2Gram)}</strong></div>
            <div className="text-sm text-slate-600 mt-1">Kecepatan max: <strong>{trip.maxSpeedKmh ? `${trip.maxSpeedKmh} km/h` : "—"}</strong></div>
            <div className="text-sm text-slate-600 mt-1">Status: <strong>{trip.suspicious ? "⚠️ Suspicious" : "OK"}</strong></div>
            <div className="text-sm text-slate-600 mt-1">Catatan: <em>{trip.note || "-"}</em></div>

            {trip.evidence && (
              <div className="mt-3">
                <div className="text-sm text-slate-600 mb-1">Bukti</div>
                {trip.evidence.startsWith("data:image/") ? <img src={trip.evidence} alt="bukti" className="max-h-40 object-contain" /> : <video src={trip.evidence} controls className="max-h-40" />}
                <div className="mt-2"><button onClick={()=>removeEvidenceForTrip(trip.id)} className="rounded-xl border px-3 py-1 text-xs">Hapus preview bukti</button></div>
              </div>
            )}
          </div>
          <div>
            {trip.routeGeoJSON && mapReady ? <div style={{height:260}}><RouteMap routeGeoJSON={trip.routeGeoJSON} /></div> : <div className="h-[260px] flex items-center justify-center text-slate-500 border rounded-xl">Tidak ada rute untuk perjalanan ini.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function RouteMap({ routeGeoJSON }) {
  const { MapContainer, TileLayer, Polyline } = LeafletLibs;
  const mapRef = useRef(null);
  const [stroke, setStroke] = useState(6);

  if (!MapContainer) return <div className="h-full w-full flex items-center justify-center text-slate-500">Map libs tidak siap</div>;
  const coords = routeGeoJSON.geometry.coordinates.map(c => [c[1], c[0]]);
  const center = coords.length ? coords[Math.floor(coords.length/2)] : [-6.2, 106.816666];

  return (
    <div className="gm-map-wrapper" style={{height: "100%", width: "100%"}}>
      <MapContainer className="modal-active" center={center} zoom={14} style={{ height: "100%", width: "100%" }} scrollWheelZoom={false} whenCreated={(map)=>{ mapRef.current = map; try{ const bounds = L.latLngBounds(coords); map.fitBounds(bounds, { padding: [12,12] }); }catch{} setTimeout(()=>map.invalidateSize && map.invalidateSize(),200); const updateStroke = () => setStroke(Math.max(2, Math.round(map.getZoom()))); updateStroke(); map.on("zoomend", updateStroke); }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
        {coords.length >= 2 && <Polyline positions={coords} pathOptions={{ color: "#10b981", weight: stroke, lineJoin: "round", smoothFactor: 1.2 }} />}
      </MapContainer>
    </div>
  );
}

/* ---------- History / Challenges / Rewards / Leaderboard ---------- */

function History({ state, leafletReady, ensureLeaflet, openTripDetail }) {
  useEffect(() => { if (!leafletReady) ensureLeaflet(); }, [leafletReady, ensureLeaflet]);
  return (
    <div className="grid gap-4">
      <Card title="Semua Perjalanan (History)">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500"><th className="py-2">Tanggal</th><th>Moda</th><th>Jarak</th><th>Poin</th><th>Map</th><th>Catatan</th></tr>
          </thead>
          <tbody>
            {(state.trips || []).map(t => (
              <tr key={t.id} className="border-t hover:bg-emerald-50">
                <td className="py-2 cursor-pointer" onClick={()=>openTripDetail(t)}>{t.date}</td>
                <td className="cursor-pointer" onClick={()=>openTripDetail(t)}>{MODE_LABELS[t.mode]}</td>
                <td className="cursor-pointer" onClick={()=>openTripDetail(t)}>{displayKmRaw(t.distanceKm || 0)}</td>
                <td className="cursor-pointer" onClick={()=>openTripDetail(t)}>{t.points}</td>
                <td>
                  {t.routeGeoJSON ? (
                    <div className="h-20 w-28 rounded overflow-hidden border" onClick={()=>openTripDetail(t)} style={{cursor:"pointer"}}>
                      <MiniRouteMap routeGeoJSON={t.routeGeoJSON} />
                    </div>
                  ) : <div className="text-xs text-slate-400">—</div>}
                </td>
                <td className="cursor-pointer" onClick={()=>openTripDetail(t)}>{t.note || "-"}</td>
              </tr>
            ))}
            {(state.trips || []).length===0 && <tr><td colSpan={6} className="py-4 text-center text-slate-500">Belum ada perjalanan.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function SmallChallengeTile({ state, type="walk" }) {
  const c = state.challenges || {};
  const isAiko = (state.user.name || "").toLowerCase() === "aiko" || (state.user.id || "").toLowerCase() === "aiko";
  if (type === "walk") {
    const value = isAiko ? 3 : (c.dailyWalkKm || 0);
    return (
      <div className="rounded-xl border p-3 bg-white">
        <div className="text-sm text-slate-600">Jalan</div>
        <div className="mt-2 flex items-center justify-between">
          <div className="text-lg font-semibold">{value} / 5 km</div>
          <PillFive progress={Math.min(5, Math.round(value))} total={5} />
        </div>
        <div className="text-xs text-slate-400 mt-2">Target harian: 5 km</div>
      </div>
    );
  }
  if (type === "transit") {
    const value = c.weeklyTransitCount || 0;
    return (
      <div className="rounded-xl border p-3 bg-white">
        <div className="text-sm text-slate-600">Transit</div>
        <div className="mt-2 flex items-center justify-between">
          <div className="text-lg font-semibold">{value} / 5x</div>
          <PillFive progress={Math.min(5, value)} total={5} />
        </div>
        <div className="text-xs text-slate-400 mt-2">Target mingguan: 5x</div>
      </div>
    );
  }
  const value = c.monthlyReductionPct || 0;
  return (
    <div className="rounded-xl border p-3 bg-white">
      <div className="text-sm text-slate-600">Reduksi Emisi</div>
      <div className="mt-2 flex items-center justify-between">
        <div className="text-lg font-semibold">{value}%</div>
        <div className="text-xs text-slate-400">Target: 30%</div>
      </div>
      <div className="text-xs text-slate-400 mt-2">Progress bulanan</div>
    </div>
  );
}
function PillFive({ progress = 0, total = 5 }) {
  const pills = Array.from({length: total}).map((_, i) => i < progress);
  return <div className="flex gap-1">{pills.map((on,i)=>(<div key={i} className={`w-4 h-4 rounded-sm ${on ? "bg-emerald-600" : "bg-slate-200"}`} />))}</div>;
}

function Challenges({ state }) {
  const c = state.challenges || {};
  const dailyGoalKm = 5;
  const weeklyGoalTransit = 5;
  const monthlyGoalPct = 30;
  const isAiko = (state.user.name || "").toLowerCase() === "aiko" || (state.user.id || "").toLowerCase() === "aiko";
  const dailyValue = isAiko ? 3 : (c.dailyWalkKm || 0);

  return (
    <div className="grid gap-4">
      <Card title="Tantangan Harian">
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="rounded-xl border p-4 bg-white">
            <div className="flex items-center justify-between">
              <div><div className="text-sm text-slate-600">Jalan</div><div className="text-lg font-semibold mt-1">{dailyValue} / {dailyGoalKm} km</div></div>
              <PillFive progress={Math.min(dailyGoalKm, Math.round(dailyValue))} total={dailyGoalKm > 5 ? 5 : dailyGoalKm} />
            </div>
            <div className="text-xs text-slate-400 mt-3">Target harian: {dailyGoalKm} km</div>
          </div>

          <div className="rounded-xl border p-4 bg-white">
            <div className="flex items-center justify-between">
              <div><div className="text-sm text-slate-600">Transit (minggu)</div><div className="text-lg font-semibold mt-1">{c.weeklyTransitCount || 0} / {weeklyGoalTransit} kali</div></div>
              <PillFive progress={Math.min(weeklyGoalTransit, c.weeklyTransitCount || 0)} total={weeklyGoalTransit} />
            </div>
            <div className="text-xs text-slate-400 mt-3">Lakukan transit ramah lingkungan</div>
          </div>

          <div className="rounded-xl border p-4 bg-white">
            <div className="flex items-center justify-between">
              <div><div className="text-sm text-slate-600">Reduksi bulanan</div><div className="text-lg font-semibold mt-1">{c.monthlyReductionPct || 0}% / {monthlyGoalPct}%</div></div>
              <div className="text-xs text-slate-400">{Math.round(((c.monthlyReductionPct||0)/monthlyGoalPct)*100 || 0)}%</div>
            </div>
            <div className="text-xs text-slate-400 mt-3">Target bulanan: {monthlyGoalPct}%</div>
          </div>
        </div>
      </Card>

      <Card title="Achievement">
        <div className="flex flex-wrap gap-2">
          <Chip label="Eco Explorer – 100 km jalan" achieved={(state.trips.filter(t=>t.mode==='walk').reduce((a,t)=>a+t.distanceKm,0))>=100} />
          <Chip label="Transit Hero – 50x transit" achieved={state.trips.filter(t=>['bus','krl','mrt'].includes(t.mode)).length>=50} />
          <Chip label="Carbon Saver – 1 ton CO₂" achieved={(state.totals.co2SavedGram||0)>=1_000_000} />
        </div>
      </Card>
    </div>
  );
}
function Chip({ label, achieved }) { return (<span className={`px-3 py-1 rounded-full border text-sm ${achieved ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-emerald-200'}`} style={{maxWidth:220, wordBreak:"break-word", whiteSpace:"normal"}}>{label}</span>); }

function Rewards({ state, onRedeem }) {
  return (
    <div className="grid gap-4">
      <div className="grid sm:grid-cols-3 gap-3">
        {state.rewards.map(r => (
          <div key={r.id} className="rounded-xl border p-4 bg-white">
            <div className="font-medium">{r.name}</div>
            <div className="text-xs text-slate-600 mt-1">Biaya: {r.cost} pts • Stok: {r.stock}</div>
            <button onClick={()=>onRedeem(r.id)} disabled={(state.totals.points || 0) < r.cost || r.stock<=0} className={`mt-3 w-full rounded-xl px-4 py-2 ${(state.totals.points || 0) < r.cost || r.stock<=0 ? 'bg-slate-200 text-slate-500' : 'bg-emerald-600 text-white'}`}>Tukar</button>
          </div>
        ))}
      </div>

      <Card title="Riwayat Penukaran">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500"><th>Tanggal</th><th>Reward</th></tr></thead>
          <tbody>
            {(state.redeemHistory || []).map(r => (<tr key={r.id} className="border-t"><td className="py-2">{new Date(r.date).toLocaleString()}</td><td>{r.name}</td></tr>))}
            {!(state.redeemHistory||[]).length && <tr><td colSpan={2} className="py-4 text-center text-slate-500">Belum ada penukaran.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Leaderboard({ state }) {
  const rows = [...(state.leaderboard||[])].sort((a,b)=>b.points-a.points);
  const myName = (state.user && state.user.name) || "";
  return (
    <div>
      <Card title="Peringkat Komunitas">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500"><th>#</th><th>Nama</th><th>Poin</th></tr></thead>
          <tbody>
            {rows.map((u,i) => { const isYou = (u.id === "me") || (u.name === myName); const displayName = isYou ? `${u.name} (Anda)` : u.name; return <tr key={u.id} className="border-t"><td className="py-2">{i+1}</td><td>{displayName}</td><td>{fmt(u.points)}</td></tr>; })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ---------- Profile & About ---------- */

function Profile({ state, setState, sessionUser, onLogout }) {
  const [profile, setProfile] = useState(state.user.profile || { nama: "", ttl: "", email: "", phone: "" });

  useEffect(()=>{ setProfile(state.user.profile || { nama: "", ttl: "", email: "", phone: "" }); }, [state.user.profile]);

  const saveProfile = () => {
    setState(prev => {
      const user = { ...prev.user, profile: { ...profile } };
      const newState = { ...prev, user };
      if (sessionUser) saveStateForUser(newState, sessionUser);
      return newState;
    });
    alert("Profil disimpan.");
  };

  const resetAll = () => { if(!confirm("Reset semua data demo untuk user ini?")) return; saveStateForUser(makeSeededAikoState(), sessionUser); window.location.reload(); };

  return (
    <div className="grid gap-4">
      <Card title="Profil">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-sm">Nama</label>
            <input className="border rounded-xl px-3 py-2 w-full" value={profile.nama} onChange={e=>setProfile({...profile, nama: e.target.value})} />

            <label className="text-sm mt-3">TTL</label>
            <input className="border rounded-xl px-3 py-2 w-full" value={profile.ttl} onChange={e=>setProfile({...profile, ttl: e.target.value})} />

            <label className="text-sm mt-3">Email</label>
            <input className="border rounded-xl px-3 py-2 w-full" value={profile.email} onChange={e=>setProfile({...profile, email: e.target.value})} />

            <label className="text-sm mt-3">No HP</label>
            <input className="border rounded-xl px-3 py-2 w-full" value={profile.phone} onChange={e=>setProfile({...profile, phone: e.target.value})} />

            <div className="flex gap-2 mt-4">
              <button onClick={saveProfile} className="rounded-xl bg-emerald-600 text-white px-4 py-2">Simpan</button>
              <button onClick={onLogout} className="rounded-xl border px-4 py-2 btn-logout">Logout</button>
            </div>
          </div>

          <div className="rounded-xl border p-4 bg-emerald-50">
            <div className="text-sm">Informasi akun</div>
            <div className="text-xs text-slate-600 mt-2">Nama akun: <strong>{state.user.name}</strong></div>
            <div className="text-xs text-slate-600 mt-1">Tier: <strong>{state.user.tier}</strong></div>
            <div className="text-xs text-slate-600 mt-1">Poin: <strong>{fmt(state.totals.points || 0)}</strong></div>
            <div className="text-xs text-slate-600 mt-2">Tip: Gunakan Export/Import di halaman Tentang jika ingin menyamakan localStorage antar device/origin.</div>
            <div className="mt-3"><button onClick={resetAll} className="rounded-xl border px-3 py-1 text-xs">Reset Demo (user ini)</button></div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function About({ state }) {
  const downloadJson = (obj, name) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const exportLS = () => {
    const d = {};
    for (const k of Object.keys(localStorage)) d[k]=localStorage.getItem(k);
    downloadJson(d, `localStorage-${location.hostname}.json`);
  };

  const importLS = (file) => {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        for (const k in d) localStorage.setItem(k, d[k]);
        alert("Import selesai. Reload halaman untuk melihat perubahan.");
        location.reload();
      } catch (e) { alert("Import gagal: " + e.message); }
    };
    fr.readAsText(file);
  };

  return (
    <div className="grid gap-4">
      <Card title="Tentang GreenMiles">
        <div className="prose text-sm">
          <h3>GreenMiles — Aplikasi Transportasi Hijau dengan Gamifikasi</h3>
          <p>GreenMiles mendorong pengguna beralih ke moda transportasi ramah lingkungan (jalan kaki, sepeda, transportasi umum) dengan memberi insentif berupa GreenPoints. Aplikasi menghitung jarak, durasi, dan estimasi emisi CO₂ untuk memberikan insight, tantangan, dan reward.</p>

          <h4>Fitur Utama</h4>
          <ul>
            <li>Eco-Tracker — tracking jarak & estimasi emisi (demo).</li>
            <li>Eco-Challenges — tantangan harian/mingguan/bulanan untuk mendorong kebiasaan sehat dan ramah lingkungan.</li>
            <li>GreenPoints & Rewards — tukar poin dengan voucher/kupon.</li>
            <li>Leaderboard & Achievement badges.</li>
          </ul>

          <h4>Skema Poin & Tier</h4>
          <ul>
            <li>Jalan Kaki: 10 pts/km</li>
            <li>Sepeda: 8 pts/km</li>
            <li>Transportasi Umum: 5 pts/km</li>
            <li>Kendaraan pribadi: 0 pts/km</li>
          </ul>

          <h4>Tiers</h4>
          <ul>
            <li>Bronze — starter</li>
            <li>Silver — ≥ 500 km green</li>
            <li>Gold — ≥ 1,000 km green</li>
            <li>Platinum — ≥ 5,000 km green</li>
          </ul>

          <h4>Catatan teknis</h4>
          <ol>
            <li>LocalStorage bersifat per-origin: <code>http://localhost:5173</code> dan <code>http://192.168.x.x:5173</code> adalah origin berbeda — untuk menyamakan data gunakan Export/Import atau jalankan dev server lewat satu origin (ngrok/HTTPS).</li>
            <li>Untuk iPhone: gunakan HTTPS agar permission lokasi bekerja andal.</li>
          </ol>

          <h4>Faktor Emisi (gCO₂/km)</h4>
          <ul>
            {Object.entries(CO2_FACTORS_G_PER_KM).map(([k,v]) => <li key={k}>{MODE_LABELS[k]}: <strong>{v}</strong></li>)}
          </ul>
        </div>

        <div className="mt-4 flex gap-3">
          <button onClick={exportLS} className="rounded-xl bg-emerald-600 text-white px-4 py-2">Export localStorage</button>
          <label className="rounded-xl border px-4 py-2 cursor-pointer">
            Import localStorage
            <input type="file" accept="application/json" onChange={(e)=>importLS(e.target.files && e.target.files[0])} style={{display:"none"}} />
          </label>
        </div>
      </Card>

      <Card title="Kontak & Tim">
        <div className="text-sm">Demo & prototype — untuk produksi butuh backend, validasi data, dan integrasi penyedia rute yang sesuai.</div>
      </Card>
    </div>
  );
}

/* End of file */
