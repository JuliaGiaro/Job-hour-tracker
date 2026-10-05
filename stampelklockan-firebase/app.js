// Stämpelklockan: Firebase Authentication (e-post/lösenord) + Cloud Firestore.
// Datamodell (se firestore.rules):
//   users/{uid}                 inställningar: target, lunch, updatedAt
//   users/{uid}/days/{datum}    en dag: date, clockIn, clockOut, lunch, updatedAt
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, setDoc, deleteDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAq3aNwHL4f4hR1u2ku9F5D5KZAP04nLL4",
  authDomain: "job-hour-tracker.firebaseapp.com",
  projectId: "job-hour-tracker",
  storageBucket: "job-hour-tracker.firebasestorage.app",
  messagingSenderId: "985842776564",
  appId: "1:985842776564:web:e6f664f6c2d99d20b5e1a1",
  measurementId: "G-G4K2Q0J4RK"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "sv";

// Lokal cache gör att stämplingar fungerar utan nät och skickas när telefonen är online igen.
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  db = getFirestore(app);
}

/* ---------- hjälpfunktioner ---------- */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const keyOf = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const DEFAULTS = { target: 8, lunch: 30 };

let uid = null;
let settings = { ...DEFAULTS };
let days = {};            // datum -> { date, clockIn, clockOut, lunch }
let loaded = false;
let viewPeriod = null;
let lastStamp = null;
let editingKey = null;
let unsubs = [];

/* ---------- perioder: 26:e till 25:e ---------- */
function periodEnd(key) {
  let [y, m, d] = key.split("-").map(Number);
  if (d > 25) { m++; if (m > 12) { m = 1; y++; } }
  return y + "-" + pad(m) + "-25";
}
function shiftPeriod(endKey, n) {
  let [y, m] = endKey.split("-").map(Number);
  m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
  return y + "-" + pad(m) + "-25";
}
const periodStart = endKey => shiftPeriod(endKey, -1).slice(0, 8) + "26";
const shortDate = key => new Date(key + "T12:00").toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
const dayName = key => new Date(key + "T12:00").toLocaleDateString("sv-SE", { weekday: "short", day: "numeric" });

/* ---------- timmar ---------- */
function dayHours(day) {
  if (!day || !day.clockIn || !day.clockOut) return null;
  let mins = toMin(day.clockOut) - toMin(day.clockIn);
  if (mins < 0) mins += 1440;
  return (mins - (Number(day.lunch) || 0)) / 60;
}
function fmt(h, signed) {
  const neg = h < 0; const t = Math.round(Math.abs(h) * 60);
  const s = Math.floor(t / 60) + " h " + pad(t % 60) + " min";
  if (!signed) return s;
  return (t === 0 ? "" : neg ? "−" : "+") + s;
}
const sortedDays = () => Object.keys(days).sort().map(k => [k, days[k]]);
function openShift() {
  const list = sortedDays().filter(([, d]) => d.clockIn && !d.clockOut);
  return list.length ? list[list.length - 1] : null;
}

/* ---------- Firestore ---------- */
const dayRef = key => doc(db, "users", uid, "days", key);

function saveDay(key, day) {
  // Uppdatera skärmen direkt; Firestore köar skrivningen om nätet saknas.
  if (day) {
    const data = { date: key, clockIn: day.clockIn, clockOut: day.clockOut || null, lunch: Number(day.lunch) || 0 };
    days[key] = data;
    setDoc(dayRef(key), { ...data, updatedAt: serverTimestamp() }).catch(fail);
  } else {
    delete days[key];
    deleteDoc(dayRef(key)).catch(fail);
  }
  render();
}
function saveSettings() {
  setDoc(doc(db, "users", uid), {
    target: Number(settings.target), lunch: Math.round(Number(settings.lunch)), updatedAt: serverTimestamp()
  }).catch(fail);
}
function fail(e) {
  console.error(e);
  const code = e && e.code;
  toast(code === "permission-denied"
    ? "Servern nekade sparningen. Kontrollera att säkerhetsreglerna är publicerade."
    : "Kunde inte spara just nu. Försök igen om en stund.");
}

function listen() {
  unsubs.push(onSnapshot(doc(db, "users", uid), snap => {
    const d = snap.exists() ? snap.data() : {};
    settings = { target: d.target ?? DEFAULTS.target, lunch: d.lunch ?? DEFAULTS.lunch };
    render();
  }, fail));
  unsubs.push(onSnapshot(collection(db, "users", uid, "days"), { includeMetadataChanges: true }, snap => {
    const fresh = {};
    snap.forEach(d => {
      const v = d.data();
      fresh[d.id] = { date: d.id, clockIn: v.clockIn, clockOut: v.clockOut || null, lunch: v.lunch || 0 };
    });
    days = fresh; loaded = true;
    $("sync").textContent = snap.metadata.hasPendingWrites
      ? "Sparat på telefonen. Skickas när du har nät."
      : snap.metadata.fromCache ? "Visar sparade tider. Ansluter…" : "";
    render();
  }, fail));
}
function stopListening() { unsubs.forEach(u => u()); unsubs = []; }

/* ---------- inloggning ---------- */
let signUpMode = false;
function setAuthMode(up) {
  signUpMode = up;
  $("authTitle").textContent = up ? "Skapa konto" : "Logga in";
  $("aSubmit").textContent = up ? "Skapa konto" : "Logga in";
  $("aToggle").textContent = up ? "Jag har redan ett konto" : "Skapa konto";
  $("aPass").autocomplete = up ? "new-password" : "current-password";
  $("aReset").hidden = up;
  $("aError").textContent = "";
}
const authMessages = {
  "auth/invalid-credential": "Fel e-post eller lösenord.",
  "auth/invalid-email": "E-postadressen ser inte rätt ut.",
  "auth/missing-password": "Skriv ett lösenord.",
  "auth/email-already-in-use": "Det finns redan ett konto med den e-postadressen. Logga in i stället.",
  "auth/weak-password": "Lösenordet måste vara minst 6 tecken.",
  "auth/too-many-requests": "För många försök. Vänta en stund och försök igen.",
  "auth/network-request-failed": "Ingen anslutning. Kontrollera nätet.",
  "auth/operation-not-allowed": "Inloggning med e-post är inte aktiverad i Firebase än."
};
$("aToggle").onclick = () => setAuthMode(!signUpMode);
$("authForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("aEmail").value.trim(), pass = $("aPass").value;
  $("aError").textContent = ""; $("aSubmit").disabled = true;
  try {
    if (signUpMode) await createUserWithEmailAndPassword(auth, email, pass);
    else await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    $("aError").textContent = authMessages[err.code] || "Något gick fel. Försök igen.";
  } finally { $("aSubmit").disabled = false; }
};
$("aReset").onclick = async () => {
  const email = $("aEmail").value.trim();
  if (!email) { $("aError").textContent = "Skriv din e-post först, tryck sedan här igen."; return; }
  try {
    await sendPasswordResetEmail(auth, email);
    $("aError").textContent = "";
    toast("Om kontot finns har ett mejl skickats till " + email + ".");
  } catch (err) { $("aError").textContent = authMessages[err.code] || "Kunde inte skicka mejlet."; }
};
$("signOut").onclick = () => signOut(auth);

onAuthStateChanged(auth, user => {
  stopListening();
  days = {}; settings = { ...DEFAULTS }; loaded = false; viewPeriod = null;
  uid = user ? user.uid : null;
  $("authView").hidden = !!user;
  $("appView").hidden = !user;
  if (user) {
    $("whoEmail").textContent = user.email || "";
    $("aPass").value = "";
    listen();
  } else {
    setAuthMode(false);
  }
  render();
});

/* ---------- knappar ---------- */
$("primary").onclick = () => {
  const now = new Date(), open = openShift();
  if (open) {
    lastStamp = open[0] + ":out";
    saveDay(open[0], { ...open[1], clockOut: hm(now) });
  } else {
    const k = keyOf(now);
    if (days[k] && days[k].clockOut) return;
    lastStamp = k + ":in";
    saveDay(k, { clockIn: hm(now), clockOut: null, lunch: 0 });
  }
};
$("lunch").onclick = () => {
  const open = openShift(); if (!open || open[1].lunch) return;
  lastStamp = open[0] + ":lunch";
  saveDay(open[0], { ...open[1], lunch: Number(settings.lunch) || 30 });
};
$("undo").onclick = () => {
  const k = keyOf(new Date()); if (!days[k]) return;
  lastStamp = null; saveDay(k, { ...days[k], clockOut: null });
};
$("prev").onclick = () => { viewPeriod = shiftPeriod(viewPeriod, -1); render(); };
$("next").onclick = () => { viewPeriod = shiftPeriod(viewPeriod, 1); render(); };

$("sTarget").onchange = e => { const v = parseFloat(e.target.value); if (v >= 1 && v <= 24) { settings.target = v; saveSettings(); render(); } else render(); };
$("sLunch").onchange = e => { const v = parseInt(e.target.value, 10); if (v >= 0 && v <= 180) { settings.lunch = v; saveSettings(); } else render(); };

/* ---------- rätta / lägga till dag ---------- */
function openEdit(key) {
  editingKey = key;
  const d = key ? days[key] : null;
  $("editTitle").textContent = key ? "Rätta " + dayName(key) : "Lägg till dag";
  $("dateField").hidden = !!key;
  $("eDate").value = keyOf(new Date());
  $("eIn").value = d ? d.clockIn || "" : "08:00";
  $("eOut").value = d ? d.clockOut || "" : "16:30";
  $("eLunch").value = d ? (d.lunch || 0) : settings.lunch;
  $("eDelete").hidden = !key;
  $("edit").showModal();
}
$("addDay").onclick = () => openEdit(null);
$("eCancel").onclick = () => $("edit").close();
$("eSave").onclick = () => {
  const key = editingKey || $("eDate").value;
  const lunch = parseInt($("eLunch").value, 10) || 0;
  if (!key || !$("eIn").value) { toast("Fyll i datum och intid."); return; }
  if (lunch < 0 || lunch > 180) { toast("Lunch kan vara 0 till 180 minuter."); return; }
  if (!editingKey && days[key]) { toast("Den dagen finns redan. Tryck på raden för att rätta den."); return; }
  lastStamp = null;
  saveDay(key, { clockIn: $("eIn").value, clockOut: $("eOut").value || null, lunch });
  $("edit").close();
};
$("eDelete").onclick = () => {
  if (editingKey && confirm("Ta bort " + dayName(editingKey) + "?")) { lastStamp = null; saveDay(editingKey, null); }
  $("edit").close();
};

/* ---------- export ---------- */
$("export").onclick = () => {
  const end = viewPeriod, start = periodStart(end);
  const keys = Object.keys(days).filter(k => k >= start && k <= end).sort();
  const num = n => n.toFixed(2).replace(".", ",");
  const lines = ["Datum;In;Ut;Lunch (min);Timmar;Över/under"];
  let sumH = 0, sumD = 0;
  keys.forEach(k => {
    const d = days[k], h = dayHours(d);
    if (h !== null) { sumH += h; sumD += h - settings.target; }
    lines.push([k, d.clockIn || "", d.clockOut || "", d.lunch || 0, h === null ? "" : num(h), h === null ? "" : num(h - settings.target)].join(";"));
  });
  lines.push(["Summa", "", "", "", num(sumH), num(sumD)].join(";"));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "tidkort-" + start + "-till-" + end + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ---------- visning ---------- */
const stampSpan = (text, id) => lastStamp === id ? '<span class="stamped">' + text + "</span>" : text;
const setSigned = (el, v) => { el.textContent = fmt(v, true); el.className = v > 0.001 ? "pos" : v < -0.001 ? "neg" : ""; };

function render() {
  const now = new Date(), todayK = keyOf(now);
  $("today").textContent = now.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" });
  if (!uid) return;
  if (!viewPeriod) viewPeriod = periodEnd(todayK);
  if (document.activeElement !== $("sTarget")) $("sTarget").value = settings.target;
  if (document.activeElement !== $("sLunch")) $("sLunch").value = settings.lunch;

  const P = $("primary"), L = $("lunch");
  P.classList.remove("out"); $("undo").hidden = true;
  if (!loaded) {
    $("status").textContent = "Hämtar dina tider…"; $("big").innerHTML = "&nbsp;";
    P.disabled = true; L.hidden = true;
  } else {
    P.disabled = false;
    const open = openShift(), today = days[todayK];
    if (open) {
      const [k, d] = open;
      const mins = Math.max(0, Math.floor((now - new Date(k + "T" + d.clockIn)) / 60000 - (Number(d.lunch) || 0)));
      $("status").textContent = (k === todayK ? "Instämplad " : "Instämplad " + dayName(k) + " ") + d.clockIn + (d.lunch ? ", lunch loggad" : "");
      $("big").textContent = Math.floor(mins / 60) + " h " + pad(mins % 60) + " min";
      P.textContent = "Ska ut. Nu är det slut."; P.classList.add("out");
      L.hidden = false; L.disabled = !!d.lunch;
      L.textContent = d.lunch ? "Lunch loggad (" + d.lunch + " min)" : "Äh, nu tar vi lunch";
    } else if (today && today.clockOut) {
      const h = dayHours(today), diff = h - settings.target;
      $("status").textContent = "Klar för idag, " + today.clockIn + " till " + today.clockOut;
      $("big").textContent = fmt(h);
      P.textContent = diff >= 0 ? "Bra jobbat. " + fmt(diff, true) + " idag." : fmt(diff, true) + " idag.";
      P.disabled = true; L.hidden = true; $("undo").hidden = false;
    } else {
      $("status").textContent = "Inte instämplad";
      $("big").textContent = hm(now);
      P.textContent = "Clock in, lock in"; L.hidden = true;
    }
  }

  // tidkort för vald period
  const end = viewPeriod, start = periodStart(end);
  $("periodLabel").textContent = shortDate(start) + " till " + shortDate(end);
  $("next").disabled = end >= periodEnd(todayK);
  let sumH = 0, sumD = 0, bal = 0;
  sortedDays().forEach(([, d]) => { const h = dayHours(d); if (h !== null) bal += h - settings.target; });
  const keys = Object.keys(days).filter(k => k >= start && k <= end).sort().reverse();
  let rows = "";
  keys.forEach(k => {
    const d = days[k], h = dayHours(d);
    if (h !== null) { sumH += h; sumD += h - settings.target; }
    const diff = h === null ? "" : h - settings.target;
    const cls = h === null ? "" : diff > 0.001 ? "pos" : diff < -0.001 ? "neg" : "";
    rows += '<tr class="day" data-k="' + k + '" tabindex="0"><td>' + dayName(k) + "</td>" +
      '<td class="t">' + stampSpan(d.clockIn || "", k + ":in") + "</td>" +
      '<td class="t' + (d.clockOut ? "" : " open") + '">' + (d.clockOut ? stampSpan(d.clockOut, k + ":out") : "pågår") + "</td>" +
      "<td>" + (d.lunch ? stampSpan(d.lunch + "'", k + ":lunch") : "–") + "</td>" +
      '<td class="r ' + cls + '">' + (h === null ? "" : fmt(diff, true)) + "</td></tr>";
  });
  $("rowsWrap").innerHTML = keys.length
    ? '<table class="rows"><thead><tr><th>Dag</th><th>In</th><th>Ut</th><th>Lunch</th><th class="r">±</th></tr></thead><tbody>' + rows + "</tbody></table>"
    : '<p class="empty">' + (loaded ? "Inga dagar i den här perioden än." : "Hämtar…") + "</p>";
  $("tHours").textContent = fmt(sumH);
  setSigned($("tOver"), sumD); setSigned($("tBal"), bal);
  document.querySelectorAll("tr.day").forEach(tr => {
    tr.onclick = () => openEdit(tr.dataset.k);
    tr.onkeydown = e => { if (e.key === "Enter") openEdit(tr.dataset.k); };
  });
  setTimeout(() => { lastStamp = null; }, 400);
}

let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.display = "none"), 4000);
}

setInterval(render, 20000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
render();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
