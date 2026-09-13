import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY || "dummy-key");

export async function sendOtpEmail(email: string, otp: string) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[DEV] Would send OTP ${otp} to ${email}`);
    return;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; background-color: #0A0A0A; padding: 40px; border-radius: 16px; color: #FFFFFF;">
      <h2 style="color: #FFFFFF; font-size: 24px; font-weight: 700; margin-bottom: 24px; text-align: center;">
        Welcome to <span style="color: #00E676;">Expenso</span>
      </h2>
      <p style="color: #A0A0A0; font-size: 16px; line-height: 1.5; margin-bottom: 32px; text-align: center;">
        Your authentication code is below. Please enter it in the app to verify your email address.
      </p>
      <div style="background-color: #1A1A1A; border: 1px solid #333333; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 32px;">
        <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #00E676;">
          ${otp}
        </span>
      </div>
      <p style="color: #666666; font-size: 14px; text-align: center;">
        This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;

  try {
    await resend.emails.send({
      from: "Expenso <auth@resend.dev>", // For testing, Resend uses testing domain or you can use your verified domain
      to: email,
      subject: "Your Expenso Verification Code",
      html,
    });
  } catch (error) {
    console.error("Failed to send OTP email via Resend", error);
    throw new Error("Failed to send verification email");
  }
}
