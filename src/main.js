import {
  onAuthStateChanged,
  signInWithPopup,
  signInAnonymously,
  GoogleAuthProvider,
  signOut,
} from "firebase/auth";
import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  writeBatch,
} from "firebase/firestore";
import { auth, db, receiptModel } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const DAY_MS = 24 * 60 * 60 * 1000;
const CATEGORIES = ["produce", "dairy", "meat", "bakery", "frozen", "pantry", "drinks", "other"];

let user;
let stopFridgeListener;
let scannedItems = [];

// ---------- Sign-in ----------

function showAuthError(err) {
  const el = $("authError");
  el.textContent =
    err.code === "auth/operation-not-allowed" || err.code === "auth/configuration-not-found"
      ? "This sign-in method is not switched on yet in the Firebase console (Authentication > Sign-in method)."
      : err.message;
  el.hidden = false;
}

$("googleSignIn").addEventListener("click", () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch(showAuthError)
);
$("guestSignIn").addEventListener("click", () => signInAnonymously(auth).catch(showAuthError));
$("signOut").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (u) => {
  user = u;
  $("signedOut").hidden = !!u;
  $("signedIn").hidden = !u;
  $("account").hidden = !u;
  if (stopFridgeListener) stopFridgeListener();
  if (u) {
    $("who").textContent = u.isAnonymous ? "Guest" : u.displayName || u.email;
    $("authError").hidden = true;
    stopFridgeListener = listenToFridge();
  }
});

// ---------- Fridge (Firestore) ----------

const fridgeRef = () => collection(db, "users", user.uid, "fridgeItems");

function listenToFridge() {
  return onSnapshot(
    query(fridgeRef(), orderBy("expiresAt", "asc")),
    (snap) => renderFridge(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => setStatus("Could not load your fridge: " + err.message, true)
  );
}

function expiryLabel(expiresAt) {
  if (!expiresAt) return { text: "", cls: "" };
  const days = Math.ceil((expiresAt.toMillis() - Date.now()) / DAY_MS);
  if (days < 0) return { text: "Expired", cls: "bad" };
  if (days === 0) return { text: "Use today", cls: "warn" };
  if (days <= 3) return { text: `${days} day${days === 1 ? "" : "s"} left`, cls: "warn" };
  return { text: `${days} days left`, cls: "" };
}

function renderFridge(items) {
  $("emptyFridge").hidden = items.length > 0;
  const list = $("fridgeList");
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${item.name}${item.quantity > 1 ? " × " + item.quantity : ""}`;

      const meta = document.createElement("span");
      const exp = expiryLabel(item.expiresAt);
      meta.className = "meta " + exp.cls;
      meta.textContent = [item.category, exp.text].filter(Boolean).join(" · ");

      const remove = document.createElement("button");
      remove.className = "ghost small";
      remove.textContent = "Used";
      remove.addEventListener("click", () => deleteDoc(doc(fridgeRef(), item.id)));

      li.append(name, meta, remove);
      return li;
    })
  );
}

function toFridgeDoc(item) {
  const shelfLifeDays = Number(item.shelfLifeDays) > 0 ? Number(item.shelfLifeDays) : 7;
  const data = {
    name: String(item.name).trim().slice(0, 120),
    quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
    category: CATEGORIES.includes(item.category) ? item.category : "other",
    addedAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + shelfLifeDays * DAY_MS),
  };
  if (Number.isFinite(Number(item.price)) && item.price !== "" && item.price != null) {
    data.price = Number(item.price);
  }
  return data;
}

$("manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("manualName").value.trim();
  if (!name) return;
  await addDoc(fridgeRef(), toFridgeDoc({ name, quantity: $("manualQty").value }));
  $("manualName").value = "";
  $("manualQty").value = 1;
});

// ---------- Receipt scanning (Gemini via Firebase AI Logic) ----------

function setStatus(text, isError = false) {
  const el = $("scanStatus");
  el.textContent = text;
  el.className = "status" + (isError ? " error" : "");
  el.hidden = !text;
}

// Shrinks the photo so uploads are fast on mobile data, and returns base64 JPEG.
async function imageToBase64(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { dataUrl, base64: dataUrl.split(",")[1] };
}

const RECEIPT_PROMPT = `This is a photo of a grocery receipt. List only the food and drink items on it.
For each item give:
- name: a short, readable name (expand store abbreviations, e.g. "ORG BNNA" -> "Organic bananas")
- quantity: how many were bought (1 if unclear)
- category: the best matching category
- price: the line price if it is readable
- shelfLifeDays: a typical number of days the item stays good at home once bought
Skip non-food items, taxes, totals, discounts and payment lines.
If the image is not a receipt, return an empty items list.`;

$("receiptInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  $("review").hidden = true;
  setStatus("Reading your receipt…");
  try {
    const { dataUrl, base64 } = await imageToBase64(file);
    $("receiptPreview").src = dataUrl;
    $("receiptPreview").hidden = false;

    const result = await receiptModel.generateContent([
      RECEIPT_PROMPT,
      { inlineData: { data: base64, mimeType: "image/jpeg" } },
    ]);
    const parsed = JSON.parse(result.response.text());
    scannedItems = (parsed.items || []).filter((i) => i.name);

    if (scannedItems.length === 0) {
      setStatus("No food items found. Try a clearer, well-lit photo of the whole receipt.", true);
      return;
    }
    setStatus(`Found ${scannedItems.length} item${scannedItems.length === 1 ? "" : "s"}.`);
    renderReview();
  } catch (err) {
    console.error(err);
    const busy = /high demand|timed? ?out|abort|\b50[03]\b/i.test(err.message || "");
    const overQuota = /\b429\b|quota/i.test(err.message || "");
    setStatus(
      overQuota
        ? "Today's free receipt scans are used up. Add items by hand below, or try again tomorrow."
        : busy
        ?"The receipt reader is busy right now. Wait a moment and try the photo again, or add items by hand below."
        : "Could not read the receipt: " + err.message,
      true
    );
  }
});

function renderReview() {
  const list = $("reviewList");
  list.replaceChildren(
    ...scannedItems.map((item, index) => {
      const li = document.createElement("li");

      const name = document.createElement("input");
      name.value = item.name;
      name.maxLength = 120;
      name.setAttribute("aria-label", "Item name");
      name.addEventListener("input", () => (item.name = name.value));

      const qty = document.createElement("input");
      qty.type = "number";
      qty.min = 1;
      qty.value = item.quantity || 1;
      qty.setAttribute("aria-label", "Quantity");
      qty.addEventListener("input", () => (item.quantity = qty.value));

      const cat = document.createElement("select");
      cat.setAttribute("aria-label", "Category");
      for (const c of CATEGORIES) cat.add(new Option(c, c, false, c === item.category));
      cat.addEventListener("change", () => (item.category = cat.value));

      const remove = document.createElement("button");
      remove.className = "ghost small";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        scannedItems.splice(index, 1);
        if (scannedItems.length === 0) clearReview();
        else renderReview();
      });

      li.append(name, qty, cat, remove);
      return li;
    })
  );
  $("review").hidden = false;
}

function clearReview() {
  scannedItems = [];
  $("review").hidden = true;
  $("receiptPreview").hidden = true;
  setStatus("");
}

$("discardItems").addEventListener("click", clearReview);

$("saveItems").addEventListener("click", async () => {
  const items = scannedItems.filter((i) => String(i.name).trim());
  if (items.length === 0) return;
  $("saveItems").disabled = true;
  try {
    const batch = writeBatch(db);
    for (const item of items) batch.set(doc(fridgeRef()), toFridgeDoc(item));
    await batch.commit();
    clearReview();
    setStatus(`Added ${items.length} item${items.length === 1 ? "" : "s"} to your fridge.`);
  } catch (err) {
    setStatus("Could not save: " + err.message, true);
  } finally {
    $("saveItems").disabled = false;
  }
});
