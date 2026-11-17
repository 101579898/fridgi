import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAI, getGenerativeModel, GoogleAIBackend, Schema } from "firebase/ai";

// Web config for the "fridgiprototype" Firebase project.
// These values identify the project; they are not secrets. Access is
// controlled by the Firestore rules and by sign-in.
const firebaseConfig = {
  apiKey: "AIzaSyBP5EiTCMCsCzhmqgj3kFAJcXCPAZ_DtqQ",
  authDomain: "fridgiprototype.firebaseapp.com",
  projectId: "fridgiprototype",
  storageBucket: "fridgiprototype.firebasestorage.app",
  messagingSenderId: "880330059426",
  appId: "1:880330059426:web:af69a6dcc8781e66cf71fb",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Gemini model used to read receipts. Change this one line to switch models.
export const RECEIPT_MODEL = "gemini-flash-lite-latest";

const receiptSchema = Schema.object({
  properties: {
    store: Schema.string(),
    items: Schema.array({
      items: Schema.object({
        properties: {
          name: Schema.string(),
          quantity: Schema.number(),
          category: Schema.enumString({
            enum: ["produce", "dairy", "meat", "bakery", "frozen", "pantry", "drinks", "other"],
          }),
          price: Schema.number(),
          shelfLifeDays: Schema.number(),
        },
        optionalProperties: ["price"],
      }),
    }),
  },
  optionalProperties: ["store"],
});

const ai = getAI(app, { backend: new GoogleAIBackend() });

export const receiptModel = getGenerativeModel(
  ai,
  {
    model: RECEIPT_MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: receiptSchema,
    },
  },
  // Give up after 60 seconds instead of leaving the user waiting.
  { timeout: 60000 }
);
