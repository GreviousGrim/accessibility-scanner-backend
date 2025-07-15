require('dotenv').config();

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axeCore = require('axe-core');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');

const app = express();
app.use(cors());

// In-memory store for paid IPs and expiry times (MVP quick & dirty)
const paidIPs = {};

function getUserIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

// ---- 1. STRIPE WEBHOOK ----
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✅ Webhook received! Type:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const paidIP = session.metadata?.user_ip;
      if (paidIP) {
        paidIPs[paidIP] = Date.now() + 24 * 60 * 60 * 1000;
        console.log(`🔓 Unlimited scans unlocked for IP ${paidIP} until ${new Date(paidIPs[paidIP])}`);
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(express.json());

// ---- 3. SCAN ENDPOINT ----
const scanLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1,
  message: { error: 'Free scan limit reached. Please upgrade for unlimited scans.' },
  keyGenerator: (req) => getUserIP(req),
  skip: (req) => {
    const userIP = getUserIP(req);
    const unlockExpiry = paidIPs[userIP];
    return unlockExpiry && unlockExpiry > Date.now();
  }
});

app.post('/scan', scanLimiter, async (req, res) => {
  console.log('Scan endpoint hit!', req.body);

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'No URL provided.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    await page.addScriptTag({ path: require.resolve('axe-core') });
    const results = await page.evaluate(async () => {
      return await window.axe.run();
    });

    await browser.close();
    res.json({ results });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: err.toString() });
  }
});

// ---- 4. STRIPE CHECKOUT SESSION ----
app.post('/create-checkout-session', async (req, res) => {
  const userIP = getUserIP(req);
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Accessibility Scanner — Unlimited Scans (24h Access)',
              description: 'Unlock unlimited accessibility scans for 24 hours.',
            },
            unit_amount: 799,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: 'https://accessibility-scanner-frontend.vercel.app/?token={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://accessibility-scanner-frontend.vercel.app/',
      metadata: {
        user_ip: userIP
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Accessibility Scanner backend running on port ${PORT}`);
});
