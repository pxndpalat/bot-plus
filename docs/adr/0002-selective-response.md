# ADR-0002: ตัดสินใจตอบแบบ rules + small-model judge

สถานะ: Accepted  
วันที่: 2026-08-13

## Context

บอทต้องดูเหมือนสมาชิกกลุ่ม ไม่ตอบทุกข้อความ และมีต้นทุนต่ำ ผู้ใช้ยอมรับความผิดพลาดเพราะทำเพื่อความสนุก

## Decision

- direct invocation ตอบเสมอภายใต้ mute, authorization และ safety
- ambient messages ผ่าน hard filters ก่อน แล้วรอ 15–30 วินาที
- ตอบ ambient เป้าหมาย 5–10%, ไม่เกินหนึ่งครั้งต่อ 10 ข้อความ และ cooldown 3–5 นาที
- small model ตัวเดียวคืน structured decision และ draft
- ใช้ `gpt-5-nano` เป็น default เพราะรองรับ Structured Outputs และมีต้นทุนต่ำ
- ถ้ามนุษย์ตอบประเด็นไปแล้วหรือบริบทเปลี่ยน ให้ cancel candidate
- ส่ง reply เฉพาะเมื่อ token ยังสด; ไม่ fallback เป็น push

## Consequences

- กฎราคาถูกลดจำนวน API calls
- พฤติกรรมอาจไม่แม่น แต่ตรวจสอบได้จาก reason และ score
- การรอช่วยอ่านบรรยากาศ แต่ถูกจำกัดด้วยอายุ reply token ของ LINE
- ambient failure จบด้วยความเงียบ ซึ่งเหมาะกว่าการส่งคำตอบล่าช้าหรือผิดบริบท
