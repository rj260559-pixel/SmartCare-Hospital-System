import mongoose from 'mongoose';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { gatewayReady } from './services/razorpay.js';
import { expireStaleReservations } from './services/booking.js';
import { groqReady } from './services/groq.js';

mongoose.set('strictQuery', true);

async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log('MongoDB connected');
  // Build indexes before serving traffic: the unique indexes are what make booking race-safe.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  await bootstrap();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`SmartCare API listening on http://localhost:${env.PORT}`);
    console.log(groqReady()
      ? `Groq AI: ON (model ${env.GROQ_MODEL}, key ${env.GROQ_API_KEY.slice(0, 4)}...${env.GROQ_API_KEY.slice(-4)})`
      : 'Groq AI: OFF. GROQ_API_KEY not found. Put it in server/.env (file name must be exactly ".env", not .env.txt / .env.example), then restart.');
    console.log(env.AGENT_URL ? `Fetch.ai agent: ${env.AGENT_URL} (needs: npm run agents, or npm run auto)` : 'Fetch.ai agent: OFF');
    if (env.PAYMENT_MODE === 'demo') console.log('Payments: DEMO mode (practice payment window, no real money, Razorpay not used)');
    else console.log(
      gatewayReady()
        ? `Razorpay: ${env.RAZORPAY_KEY_ID.startsWith('rzp_live') ? 'LIVE' : 'test'} mode${env.RAZORPAY_WEBHOOK_SECRET ? ' + webhook' : ' (no webhook secret set)'}`
        : 'Razorpay: NOT configured (free departments work; paid bookings return 503)'
    );
  });

  // Release unpaid reservations whose payment window ran out.
  const sweeper = setInterval(() => expireStaleReservations().catch((e) => console.error('reservation sweeper:', e.message)), 60 * 1000);
  sweeper.unref();

  const stop = async () => {
    clearInterval(sweeper);
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
