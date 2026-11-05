// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey:import.meta.env.VITE_FIREBASE_APIKEY,
  authDomain: "food-delivery-77055.firebaseapp.com",
  projectId: "food-delivery-77055",
  storageBucket: "food-delivery-77055.firebasestorage.app",
  messagingSenderId: "1018703752135",
  appId: "1:1018703752135:web:633df238a293f6f90b47e2"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth=getAuth(app)
export {app,auth}