# AI tizimi: TZ 15–23 bo'yicha ish hisoboti

Bu hujjat texnik topshiriqning 15–23-bo'limlari asosida qilingan ishni tushuntiradi: nima qilindi, qaysi fayllar
o'zgardi, testlar natijasi, nima qoldi va nima hali tekshirilmagan.

## 1. Mavjud tizim auditi (o'zgartirishdan oldin)

| Soha | Avvalgi holat |
| --- | --- |
| Telegram | grammY bot (Bot API) va Telegram Business. Userbot yo'q edi; GramJS faqat 20 MB dan katta fayllar uchun ishlatilardi |
| AI | Faqat Claude Code CLI (`claude -p`), subscription OAuth token bilan. Tool use o'chirilgan, Gemini yo'q edi |
| Xotira | JSON fayllar (`data/*.json`). Claude'ga oxirgi 50 ta xabar berilardi. Tarix 30 kundan keyin o'chirilardi |
| Admin | Bitta `OWNER_ID`. Admin erkin matn yozsa, faqat qisqa yo'l-yo'riq chiqardi |
| Mijozga javob | Jiddiy savollarda "mas'ul xodim javob beradi" deb yozilardi. Narx umuman aytilmasdi |
| Deploy | Railway, Dockerfile, `/app/data` volume |

Kelishilgan qarorlar (grill-me suhbati): Claude **API** asosiy, Gemini zaxira; faqat bot (userbot yo'q); Railway
PostgreSQL + pgvector; "mas'ul xodim" iboralari taqiqlanadi; narx faqat price-list'dan; adminlar `ADMIN_IDS` orqali,
hammasi teng; ma'lumot hech qachon avtomatik o'chirilmaydi; bot birinchi bo'lib yozmaydi; ✍️ rejimida taymer yo'q;
14 ta hujjat aynan berilgan matn va tartibda; hisobotlar faqat adminlar uchun.

## 2. Arxitektura (TZ 21)

```
Telegram update
  └─ handlers.ts ── mijoz ──▶ service.ts (Assistant)
                               ├─ dedup: seen.json + processed_updates (PostgreSQL)
                               ├─ fayl / "holat" / "anketa" ─▶ AI'siz (avvalgidek)
                               └─ Orchestrator (orchestrator/orchestrator.ts)
                                    1. Memory Manager: profil, summary, semantic search (memory.ts)
                                    2. Tahlil (tez model, JSON): tur, murakkablik, kontekst, ishonch, faktlar
                                    3. Decision Tree: workflow tanlash (orchestrator/decisionTree.ts)
                                    4. Faktlarni profilga yozish (CRM: customer_services, sales_pipeline)
                                    5. Javob (asosiy model) ─▶ 6. Self-check (orchestrator/validation.ts)
                                    7. ai_requests ga yozish, javob yuborish, summary yangilash
               ── admin ───▶ Admin AI (admin/adminAssistant.ts) ─▶ read-only tool'lar (analytics.ts) ─▶ reports.ts
AI chaqiruvlari: AIProviderManager (ai/providerManager.ts) ─▶ Claude (ai/claudeProvider.ts) | Gemini (ai/geminiProvider.ts)
```

TZ 21 dagi modullar va fayllar:

| Modul | Fayl |
| --- | --- |
| AI Orchestrator | `src/orchestrator/orchestrator.ts` |
| Decision Tree Engine | `src/orchestrator/decisionTree.ts` |
| Claude Provider / Gemini Provider | `src/ai/claudeProvider.ts`, `src/ai/geminiProvider.ts` |
| AI Provider Manager | `src/ai/providerManager.ts` |
| Memory Manager, Semantic Search | `src/memory.ts`, `src/db/database.ts` (`searchSimilar`, `searchKeyword`) |
| Customer Profile Manager | `src/db/database.ts` (`profile`, `updateProfile`) |
| Conversation Analyzer | `src/memory.ts` (`maybeSummarize`: summary + tahlil) |
| Telegram Integration | `src/handlers.ts`, `src/service.ts` |
| Admin AI Assistant | `src/admin/adminAssistant.ts` |
| CRM Manager | `customer_services`, `sales_pipeline`, `companies`, `licenses` jadvallari (`database.ts`) |
| Statistics Engine | `src/analytics.ts` |
| Report Generator | `src/reports.ts` (PDF, Excel, CSV) |
| Task Scheduler | `src/bot.ts` (navbat, Claude probe, embedding backfill), `service.ts` (kunlik hisobot) |
| Notification Manager | `service.ts` (`#notifyAdmins`, `notifyProviderSwitch`) |
| Audit Logger | `audit_logs`, `admin_actions`, `ai_provider_logs` jadvallari |

## 3. Decision Tree (TZ 15)

TZ'dagi 8 ta holat (trivial tweak, bug, feature …) dasturchi agentining daraxtidan olingan, mijoz xabari uchun
ma'nosi yo'q edi. Kelishilganidek, ular mavzuga mos toifalarga almashtirildi:

- **Xabar turi**: greeting, thanks_or_ack, info_question, service_interest, price_request, document_question,
  document_submission, status_request, complaint, emergency, official_request, partnership, off_topic, unclear.
- **Workflow**: short_answer, skip_or_short, answer_from_knowledge, sales_answer, price_answer, document_guidance,
  status, escalate, clarify, polite_redirect. Ma'lumot yetarli bo'lmasa (`insufficient` + yetishmayotgan fakt)
  `clarify` tanlanadi: bitta aniq savol beriladi, taxmin qilinmaydi.
- **Investigation**: AI xabar oldingi suhbatga bog'liq desa (`needs_history_search`), xotiradan chuqurroq qidiriladi
  va bu `workflow_path` ga yoziladi.
- **Ishonch** (TZ 19.3): yuqori (≥0.75), o'rta (≥0.45), past. O'rta bo'lsa noaniqlik ochiq aytiladi; past bo'lsa
  taxmin fakt sifatida aytilmaydi.
- Har bir so'rov uchun `ai_requests` ga yoziladi: request_id, chat_id, customer_id, request_type, complexity,
  context_completeness, selected_workflow, workflow_path, confidence, required_permissions, execution_status,
  final_result, provider, model.
- Bitta qadam xato bersa (masalan, tahlil JSON'i buzuq), standart qiymat bilan davom etiladi.

**Self-check** (6-bosqich): javob yuborishdan oldin kod tekshiradi:

1. "Mas'ul xodim / xodimimiz / mutaxassisimiz javob beradi" kabi iboralar (o'zbek, rus, ingliz tillarida) bormi?
2. Price-list'da yo'q summa aytilganmi?
3. Oxirgi javoblardan biri deyarli aynan takrorlanyaptimi?
4. Mijoz allaqachon bergan STIR, korxona nomi yoki xom-ashyo turi qayta so'ralyaptimi?

Muammo topilsa, model sababini bilgan holda javobni bir marta qayta yozadi. Taqiqlangan gap ikkinchi marta ham
chiqsa, o'sha gap olib tashlanadi. O'ylab topilgan summa ikkinchi marta ham chiqsa, xavfsiz javob (price-list
ogohlantirishi + kontaktlar) yuboriladi.

## 4. Claude + Gemini (TZ 16)

- Claude birinchi ishlatiladi. Vaqtinchalik xatolar (tarmoq, 5xx, 529, timeout) 2 marta qayta uriniladi.
- Auth, billing yoki rate limit xatosida yoki qayta urinishlar tugaganda o'sha so'rovning o'zi Gemini'ga beriladi:
  aynan o'sha system prompt, xabarlar va mijoz ma'lumotlari bilan. Shuning uchun mijozdan hech narsa qayta so'ralmaydi.
- Circuit breaker ochiladi. Har `AI_PROBE_MINUTES` (5) daqiqada Claude tekshiriladi (fon probe va keyingi so'rov).
  Javob bersa Claude'ga qaytiladi; yana ishlamasa Gemini'da qolinadi. Bu sikl cheklovsiz takrorlanadi.
- Adminlarga faqat almashinuvda bitta xabar boradi: "Claude ishlamayapti, Gemini'ga o'tildi" / "Claude tiklandi".
- Ikkalasi ham ishlamasa: xabar `pending_replies` ga yoziladi, adminlarga bir marta xabar beriladi va har daqiqada
  qayta uriniladi. Javob bir marta yuboriladi (`outgoing_replies`). Suhbat bu orada davom etib javob olgan bo'lsa,
  kechikkan javob yuborilmaydi.
- Kalitlar faqat environment'dan olinadi. Gemini kaliti URL'da emas, header'da yuboriladi; xato matnlaridan kalit
  olib tashlanadi; `.env.example` da faqat bo'sh placeholder'lar bor.

**TZ'dan farq:** `.env.example` da `CLAUDE_CODE_OAUTH_TOKEN` o'rniga `ANTHROPIC_API_KEY` turibdi (Q1 qarori). Eski
token o'rnatilgan bo'lsa, bot logda "ishlatilmaydi" deb ogohlantiradi.

## 5. Long-term memory (TZ 17)

Har bir xabarda (TZ 17.3):

1. Chat ID va mijoz aniqlanadi.
2. Oxirgi `HISTORY_LIMIT` (40) xabar olinadi (short-term).
3. Summary va profil bazadan o'qiladi.
4. Semantic search o'tkaziladi: Gemini embedding bo'lsa pgvector orqali, bo'lmasa kalit so'zlar bo'yicha. Qidiruv
   faqat shu mijozning xabarlarida.
5. AI xabarni tahlil qiladi va oldin javob berilgan-berilmaganini aniqlaydi (`already_answered`).
6. Yangi faktlar javobdan oldin saqlanadi.
7. Javob yoziladi va tekshiriladi (takror, qayta so'rash).
8. Javob yuboriladi.
9. Xabar va embedding saqlanadi, har 8 xabarda summary yangilanadi.

Faktning eski qiymati `facts` JSON maydonida saqlanadi, shuning uchun ziddiyatni aniqlash mumkin. Bir mijozning
ma'lumoti boshqa mijozga hech qachon aralashmaydi: barcha so'rovlar `customer_id` bo'yicha filtrlanadi.

## 6. Admin AI (TZ 18)

Admin bot chatida oddiy matn yozadi. AI faqat o'qish uchun mo'ljallangan tool'lar orqali haqiqiy bazadan ma'lumot
oladi:

- `get_overview`, `top_chats`, `find_customer`, `customer_details`, `customer_messages`;
- `customers_by` (price_asked, interested, complaint, rejected, offer_sent, escalated, unanswered_chat,
  license_expiring, active, documents_sent);
- `request_stats`, `unanswered_questions`, `search_messages`, `analyze_chats`, `provider_stats`, `create_report_file`.

Har admin uchun suhbat va "fokus" (oxirgi ro'yxat, muhokama qilinayotgan mijoz) saqlanadi, shuning uchun
"birinchi mijoz", "shu mijoz", "u oxirgi marta nima so'ragan" tushuniladi. `/new` yangi mavzu ochadi.

Hisobotlar PDF (DejaVu shrift, o'zbek va kirill harflari bilan), Excel yoki CSV formatida tayyorlanadi va faqat
so'ragan adminga yuboriladi. Kunlik hisobotga AI xulosasi va tavsiyalar qo'shildi.

## 7. Mijoz bilan muloqot (TZ 19)

- Taqiqlangan iboralar promptda ham, kod tekshiruvida ham to'siladi. `company.md` dagi "mas'ul xodim" yo'riqnomalari
  olib tashlandi.
- Narx faqat `knowledge/prices.json` dan aytiladi (30.10.2026 dagi tijoriy taklifdan olingan; mijoz nomi, imzo va
  muhr olinmagan; faylning o'zi hech kimga yuborilmaydi):
  - noruda xizmatlarida summa va kun aynan yozilganidek;
  - rudada va "kelishiladi" deb yozilganlarda summa aytilmaydi;
  - Toposyomka uchun muddat ko'rsatilmagan, bot uni o'ylab topmaydi;
  - narxdan keyin sizning ogohlantirish matningiz va kontaktlar qo'shiladi.
- Ro'yxatda yo'q xizmatlarga narx aytilmaydi.
- Ruda yoki noruda ekani noma'lum bo'lsa, bot avval shuni so'raydi.
- Narx so'ralganda adminlarga 💰 lead xabari boradi.
- Shikoyat, favqulodda holat va rasmiy so'rovda adminlarga 🚨 xabar boradi; mijozga xodim javob berishi va'da
  qilinmaydi.

## 8. Takror va xatolarni nazorat qilish (TZ 20)

| Mexanizm | Qanday amalga oshirilgan |
| --- | --- |
| Idempotency key | Har xabar `<manba>:<chat>:<message_id>` kaliti bilan belgilanadi |
| Message deduplication | `seen.json` va `processed_updates` (volume yo'qolsa ham ishlaydi) |
| Bir xabarga bir javob | `outgoing_replies` |
| Conversation state management | `state.json` (✍️ rejimlari), `sales_pipeline` |
| Persistent memory | PostgreSQL, muddatsiz saqlash |
| Semantic similarity | pgvector (yoki `real[]` va JS'da cosine) |
| Response validation | `validation.ts` |
| Provider fallback | AIProviderManager |
| Audit logging | `audit_logs`, `admin_actions`, `ai_provider_logs`, `ai_requests` |

Mijoz javob tayyorlanayotgan paytda yana yozsa, eski javob tashlab yuboriladi va yangi xabarga ikkala xabarni
hisobga olgan bitta javob beriladi.

## 9. Testlar (TZ 22) — natija

Hammasi lokal muhitda PostgreSQL 16 + pgvector 0.6 bilan ishga tushirildi: **72 / 72 test o'tdi**
(`documents` 44, `providers` 14, `acceptance` 14).

| TZ testi | Test nomi (`tests/acceptance.test.ts`) | Natija |
| --- | --- | --- |
| 1. Oldingi ma'lumotni eslash | Test 1 — 3 kundan keyin STIR va nom ma'lum, qayta so'ralmaydi | ✅ |
| 2. Oldingi savolga qaytish | Test 2 — semantic search eski savolni topadi, `investigation` | ✅ |
| 3. Takroriy javob | Test 3 — takror javob qayta yoziladi | ✅ |
| 4. Kontekstni saqlash | Test 4 — Claude 401 → Gemini xuddi o'sha faktlar bilan javob beradi | ✅ |
| 5. Admin statistikasi | Test 5 — top chats sonlari haqiqiy bazadan | ✅ |
| 6. Suhbat mazmuni | Test 6 — mijozning haqiqiy oxirgi savoli sanasi bilan | ✅ |
| 7. Noaniq savol | Test 7 — past ishonch, o'ylab topilgan narx almashtiriladi | ✅ |
| 8. Bir xabarga bir javob | Test 8 — takror update va `seen.json` o'chirilgandan keyin ham | ✅ |
| 9. Admin konteksti | Test 9 — "birinchi mijoz" to'g'ri aniqlanadi | ✅ |
| 10. To'liq avtomatik muloqot | Test 10 — taqiqlangan gap mijozga bormaydi | ✅ |

**Muhim:** bu testlarda Claude va Gemini soxta (scripted) provayderlar bilan almashtirilgan. Haqiqiy API
kalitlari bilan modellarning javob sifati hali tekshirilmagan. Bu ishni `AUTO_SEND=false` (preview) rejimida 1–2
hafta davomida qilish kerak.

## 10. Ishlamayotgan yoki tekshirilmagan qismlar

- **Haqiqiy Claude / Gemini chaqiruvi tekshirilmagan.** Ish muhitida kalitlar yo'q edi. Adapterlar API formatiga
  qarab yozildi va soxta HTTP javoblari bilan sinaldi. Deploydan keyin `npm run check-ai` va `npm run try` bilan
  tekshiring.
- **Model nomlari.** `claude-sonnet-5-5`, `claude-haiku-5-5`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`,
  `gemini-embedding-001` standart qiymatlar sifatida qo'yilgan. Akkauntingizda boshqacha bo'lsa, env orqali
  o'zgartiring.
- **Railway PostgreSQL'da pgvector bo'lmasligi mumkin.** Bunda bot avtomatik `real[]` rejimida ishlaydi. Ko'p ma'lumotda
  sekinroq bo'ladi; pgvector template'ini tanlash tavsiya qilinadi.
- **Litsenziya muddatlari** faqat mijoz suhbatda aytgan ma'lumotdan olinadi (Q6 qarori). Reyestr importi qilinmagan.
- **"Tijoriy taklif yuborilgan mijozlar"**: bot taklif yubormaydi. `offer_sent` belgisi faqat AI suhbatdan
  "negotiation" bosqichini aniqlaganda qo'yiladi.
- `src/claudeCli.ts` va `laws/` ishlatilmayapti, lekin o'chirilmadi (avval sizdan so'rash kerak).

## 11. O'zgargan va yangi fayllar

**Yangi:**
- `src/ai/*`, `src/orchestrator/*`, `src/db/*`, `src/admin/adminAssistant.ts`
- `src/memory.ts`, `src/analytics.ts`, `src/reports.ts`, `src/knowledge/prices.ts`
- `knowledge/prices.json`, `docs/AI-TIZIM.md`
- `tests/fakes.ts`, `tests/providers.test.ts`, `tests/acceptance.test.ts`

**O'zgargan:**
- `src/service.ts`, `src/handlers.ts`, `src/bot.ts`, `src/config.ts`, `src/store.ts`, `src/prompts.ts`
- `src/claudeCli.ts` (faqat type importi)
- `company.md`, `README.md`, `.env.example`, `Dockerfile`, `package.json`
- `tests/harness.ts`, `tests/documents.test.ts` (ruscha ro'yxat formati)
