// otp — Send and verify six-digit email OTP codes.

import { guardCall } from "./LoginGuard.js?v=20261030d";

export async function sendOtpCode(email, name) {
  try {
    await guardCall("otp_send", { email, name: name || "" });
  } catch (error) {
    if (error.message === "limit") {
      throw new Error("Too many codes were requested for this email. Please try again in an hour.");
    }
    if (error.message === "slow_down") {
      throw new Error("Please wait a moment before asking for another code.");
    }
    throw error;
  }
}

export async function verifyOtpCode(email, enteredCode) {
  try {
    const data = await guardCall("otp_verify", { email, code: enteredCode });
    return { valid: data.valid === true, message: data.message || "" };
  } catch (error) {
    console.error("Couldn't verify OTP code:", error);
    if (error.message === "slow_down") {
      return { valid: false, message: "Too many attempts. Please wait a moment and try again." };
    }
    return { valid: false, message: "Something went wrong verifying your code. Please try again." };
  }
}
