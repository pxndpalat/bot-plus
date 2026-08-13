# ADR-0001: ใช้ modular monolith บนเซิร์ฟเวอร์เดียว

สถานะ: Accepted  
วันที่: 2026-08-13

## Context

ระบบรองรับกลุ่มเดียว สมาชิกต่ำกว่า 50 คน และข้อความต่ำกว่า 1,000 ต่อวัน มีเซิร์ฟเวอร์ขนาดเล็กที่รัน Docker Compose และ public HTTPS ได้

## Decision

ใช้ TypeScript + Node.js เป็น modular monolith หนึ่ง process และ PostgreSQL หนึ่งฐานข้อมูล Background job loop อยู่ใน process เดียวกับ webhook server แต่แยก module ชัดเจน งาน delayed เก็บใน PostgreSQL

## Consequences

- deploy และ debug ง่าย ใช้ container หลักเพียง `bot-app` กับ `postgres`
- ไม่ต้องมี Redis, broker หรือ microservices
- restart แล้วยังเห็น delayed jobs แต่ job เก่าที่ reply token หมดอายุต้อง expire
- scale แนวนอนต้องเพิ่ม distributed lock ก่อน แต่ยังไม่จำเป็นใน MVP
- ไม่มี backup ตามการตัดสินใจของเจ้าของระบบ หากฐานข้อมูลหายจะเริ่มเรียนรู้ใหม่

## Rejected alternatives

- Serverless-only: delayed worker และ connection lifecycle ซับซ้อนเกินความจำเป็น
- Microservices: เพิ่ม deployment/observability cost โดยไม่มี throughput รองรับเหตุผล
- Redis queue: เป็น dependency เพิ่ม ทั้งที่ PostgreSQL รองรับปริมาณนี้ได้
