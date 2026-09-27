# کیف پول LEZ — راهنمای اجرا (Logos testnet 0.3 / LP-0021)

مونوریپوی کیف پول LEZ شامل SDK اصلی (`packages/core`) و پکیج‌های در حال توسعه. **برای تست اولیه آماده است**: بیلد تمیز می‌شود، type-check کل مونوریپو سبز است و ۷۷ تست خودکار پاس می‌شوند.

## پیش‌نیازها

| نیاز | نسخه | بررسی |
|------|-------|-------|
| Node.js | ≥ 18 | `node --version` |
| npm | ≥ 9 (همراه Node) | `npm --version` |

> SDK روی Node 18 هم کار می‌کند؛ در صورت نبودِ globalِ `crypto` (اجرای فایل در Node 18)، پیاده‌سازی `webcrypto` به‌صورت خودکار از `node:crypto` مقداردهی می‌شود. Node 20+ توصیه می‌شود.

## ۱. نصب

```bash
cd lez-wallet
npm install
```

## ۲. بیلد

```bash
npm run build      # بیلد همه workspace ها با tsc -b
npm run lint       # type-check کل مونوریپو (همان tsc -b)
```

خروجی هر پکیج در `dist/` همان پکیج ساخته می‌شود؛ مثلاً SDK کامپایل‌شده در `packages/core/dist/`.

## ۳. تست

```bash
npm test           # همه تست‌ها (77 تست در 9 فایل)
```

اجرا فقط برای core:

```bash
cd packages/core
npm test           # vitest run
npm run test:watch # حالت watch
```

پوشش تست‌ها:

| فایل تست | چه چیزی را پوشش می‌دهد |
|----------|------------------------|
| `keys.test.ts` | بردارهای رسمی BIP-39/TREZOR، mnemonic، مشتق‌کلید حساب‌ها |
| `vault.test.ts` | رمزنگاری AES-GCM، قفل/باز کردن، تغییر پسورد |
| `store.test.ts` | state ذخیره‌سازی در حافظه/فایل، نوشتن اتمیک، آپدیت همزمان |
| `assets.test.ts` | ریاضی دقیق مبلغ‌ها در base units |
| `accounts.test.ts` | ساخت/حذف حساب، خروجی کلید فقط از vault |
| `mock-backend.test.ts` | زنجیره mock: موجودی، انتقال، تأیید tx، برنامه‌ها |
| `tx.test.ts` | تاریخچه ۵۰۰تایی، تأیید tx، فیلترها |
| `approval.test.ts` | مدل capability، رد شدن توسط کاربر، alwaysPrompt |
| `sdk.test.ts` | جریان کامل dApp: connect → send → history → revealKeys → disconnect |

## ۴. دموی سرتاسری (سریع‌ترین راه تست دستی)

```bash
node scripts/demo.mjs
```

این اسکریپت بدون هیچ سرویس خارجی، جریان کامل را با زنجیره‌ی `MockBackend` نشان می‌دهد: ساخت حساب، شارژ از faucet، اتصال dApp، انتقال و تأیید tx، تاریخچه، خروجی کلید، فراخوانی برنامه `testimonial` و قرارداد خطاهای LP-0021 (`rejected_by_user`, `unauthorized`).

## ۵. دو حالت اتصال به زنجیره

| Backend | کاربرد | وابستگی |
|---------|--------|---------|
| `MockBackend` | توسعه و تست — زنجیره در حافظه | هیچ (پیش‌فرض دمو و تست‌ها) |
| `CliBackend` | testnet واقعی Logos | باینری رسمی `wallet` (Rust) و در صورت نیاز `spel` از [logos-execution-zone](https://github.com/logos-blockchain/logos-execution-zone) |

نمونه اتصال به testnet واقعی (وقتی باینری `wallet` در PATH است):

```js
import { CliBackend, WalletSDK, StateManager, FileStateStore, PasswordVault, FileVaultStorage } from "@lez/core";

const backend = new CliBackend(); // با باینری رسمی wallet صحبت می‌کند
```

نکته LP-0021: در `CliBackend` مقدار `estimateGas` همیشه `null` است (CLI رسمی زیرمجموعه gas-estimate ندارد) — فراخوان‌ها باید null را مدیریت کنند.

## ۶. نمونه استفاده از SDK

```js
import {
  WalletSDK, MockBackend, StateManager, MemoryStateStorage,
  PasswordVault, MemoryVaultStorage, NATIVE_ASSET_ID,
} from "@lez/core";

const sdk = new WalletSDK({
  backend: new MockBackend(),
  state: new StateManager(new MemoryStateStorage()),
  vault: new PasswordVault(new MemoryVaultStorage()),
  prompt: async (req) => {
    // اینجا UI واقعی (popup اکستنشن / CLI prompt) نمایش داده می‌شود
    console.log("approve?", req.origin, req.capabilities, req.note);
    return true;
  },
});

await sdk.createAccount("public", { label: "Main" });
await sdk.connect({ origin: "https://my-dapp.example" });   // grant خواندن/نوشتن پایه
const bal = await sdk.getBalance("https://my-dapp.example", acc.id, NATIVE_ASSET_ID);
const tx = await sdk.send("https://my-dapp.example", { fromAccountId: acc.id, to, amount: "1000000000" });
await sdk.tx.awaitConfirmation(tx.hash, { polls: 5, intervalMs: 500 });
```

## ۷. مدل دسترسی dApp (LP-0021)

- هر origin فقط به حسابی که grant گرفته دسترسی دارد.
- capability ها: `read_balance`, `read_state`, `propose_tx`, `read_keys`.
- **هر ارسال tx و هر خروجی کلید جداگانه تأیید می‌شود** (حتی با grant قبلی).
- کدهای خطای قراردادی: `rejected_by_user`, `unauthorized`, `account_locked`, `rpc_unavailable` (به‌علاوه کدهای داخلی مثل `invalid_input`, `not_found`, `insufficient_balance`).

## ۸. ساختار مونوریپو

```
lez-wallet/
├── packages/core/          # SDK اصلی: keys, vault, store, accounts, assets, tx, approval, sdk
│   ├── src/                #   سورس TypeScript
│   ├── tests/              #   77 تست vitest
│   └── dist/               #   خروجی بیلد (ESM + .d.ts)
├── packages/cli/           # CLI کیف پول — فعلاً stub
├── packages/extension/     # اکستنشن MV3 — فعلاً stub
├── packages/basecamp/      # یکپارچه‌سازی basecamp — فعلاً stub
├── mini-apps/              # dApp های نمونه (testimonial, faucet) — فعلاً stub
└── scripts/demo.mjs        # دموی سرتاسری قابلاجرا
```

## ۹. وضعیت فعلی و محدودیت‌ها

- ✅ `packages/core` کامل و پایدار؛ ۷۷ تست سبز؛ بیلد و type-check سبز.
- ⚠️ `cli`، `extension`، `basecamp` و `mini-apps/*` فقط اسکلت پکیج هستند (برای عبور بیلد ریشه) — پیاده‌سازی نشده‌اند.
- ⚠️ پشتیبانی testnet واقعی از طریق `CliBackend` در دسترس است اما به باینری Rust رسمی نیاز دارد و روی این محیط تست نشده است.

## عیب‌یابی

| مشکل | راه‌حل |
|------|--------|
| `crypto is not defined` | نباید رخ دهد — SDK خودش webcrypto را مقداردهی می‌کند؛ در صورت مشاهده Node را به 20+ ارتقا دهید |
| `tsc` پیدا نمی‌شود | `npm install` را در ریشه اجرا کنید |
| تست‌ها کندند | طبیعی است؛ PBKDF2 با ۲۱۰ هزار iteration انجام می‌شود (در تست‌ها تعداد کم شده) |

---

دو مجوزه: MIT OR Apache-2.0 (فایل‌های `LICENSE-MIT` و `LICENSE-APACHE`).
