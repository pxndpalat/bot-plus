# Mallnew Friends Bot

LINE AI bot สำหรับเพิ่มสีสันในกลุ่มเพื่อน โดยเลือกตอบเฉพาะบางข้อความและสร้าง persona memory ของสมาชิกจากบทสนทนา

โปรเจกต์นี้อยู่ในช่วงออกแบบ เอกสารหลักมีดังนี้:

- [Architecture](docs/architecture.md)
- [Domain glossary](docs/domain-glossary.md)
- [ADR-0001: Modular monolith](docs/adr/0001-modular-monolith.md)
- [ADR-0002: Selective response](docs/adr/0002-selective-response.md)
- [ADR-0003: Persona memory](docs/adr/0003-persona-memory.md)
- [ADR-0004: Data and safety](docs/adr/0004-data-and-safety.md)

ขอบเขต MVP คือกลุ่มเดียว สมาชิกไม่เกินประมาณ 50 คน ข้อความต่ำกว่า 1,000 ข้อความต่อวัน ใช้ TypeScript บน Bun, Elysia, PostgreSQL, OpenAI Responses API และ deploy ด้วย Docker Compose บนเซิร์ฟเวอร์ส่วนตัว
