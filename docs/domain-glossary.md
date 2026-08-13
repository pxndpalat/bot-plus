# Domain Glossary

เอกสารนี้กำหนดคำเดียวกันให้หมายถึงสิ่งเดียวกันในโค้ด ฐานข้อมูล prompt และการคุยงาน

| Term | ความหมาย |
|---|---|
| Group | กลุ่ม LINE เป้าหมายหนึ่งกลุ่ม ระบุด้วย `groupId` |
| Member | บุคคลในกลุ่ม ระบุหลักด้วย LINE `userId` |
| Alias | ชื่อเล่นหรือรูปแบบเรียก Member เช่น เอก, ไอ้เอก, คุณชายเอก |
| Webhook Event | เหตุการณ์ดิบจาก LINE เช่น message, unsend, join หรือ member-left |
| Message | ข้อความหรือ metadata ของสื่อที่สมาชิกส่ง ไม่รวม webhook envelope |
| Direct Invocation | การ `@bot`, reply ถึงบอท หรือคำสั่งที่ parse ได้ |
| Ambient Message | ข้อความทั่วไปที่ไม่ได้เรียกบอทโดยตรง |
| Conversation Episode | ช่วงสนทนาต่อเนื่อง ซึ่งสิ้นสุดเมื่อเงียบเกิน 10 นาที |
| Context Window | ข้อความที่เกี่ยวข้องไม่เกิน 20–30 ข้อความและไม่เกิน 10 นาที |
| Response Candidate | โอกาสที่บอทอาจตอบ ambient message แต่ยังไม่ใช่การอนุมัติให้ส่ง |
| Decision | structured output ที่เสนอ `respond/ignore`, score, safety และ draft |
| Cooldown | ช่วง 3–5 นาทีที่บอทไม่ควรตอบ ambient ซ้ำ |
| Persona Observation | หลักฐานหนึ่งชิ้นที่สกัดจากข้อความหรือคำสั่ง ยังไม่ใช่ข้อสรุปสุดท้าย |
| Persona Fact | ข้อสรุปปัจจุบันจากหนึ่งหรือหลาย observations |
| Claim | ข้อความสั้นที่อธิบาย fact เช่น “ชอบกินซูชิ” |
| Source Strength | น้ำหนักตามผู้พูด: self explicit, behavioral, third party หรือ correction |
| Confidence | ความเชื่อมั่น 0–1 ของ fact หลังรวมแหล่งข้อมูล ความใหม่ และความขัดแย้ง |
| Current Fact | fact ที่ resolver เลือกให้ใช้ ณ ตอนนี้เมื่อมีข้อมูลขัดกัน |
| Public Safe | fact ที่สมาชิกทั่วไปถามได้และบอทอาจใช้ในกลุ่ม |
| Risky Fact | fact ที่ใช้ได้เฉพาะเพื่อเข้าใจบริบท หรือถูก Safety Gate ห้ามกล่าวถึง |
| Safety Gate | กฎ deterministic และ model classification ก่อนส่งข้อความ |
| Forget Me | ลบข้อมูลปัจจุบันของผู้สั่ง แต่ไม่หยุดการเรียนรู้ข้อความในอนาคต |
| Memory Opt-out | หยุดสร้าง long-term persona ใหม่จนกว่าจะ opt in |
| Admin | สมาชิกที่ LINE `userId` อยู่ใน allowlist ผู้ดูแล |
| Reply Message | ข้อความที่ส่งด้วย reply token ของ webhook; ควรส่งโดยเร็ว |
| Push Message | ข้อความที่ส่งหา group ID โดยไม่ใช้ reply token และถูกนับโควตา; ไม่ใช้ fallback ใน MVP |
| Retention | เวลาที่ระบบเก็บข้อมูลก่อนลบหรือ archive |

## Domain invariants

1. LINE `userId` เป็น canonical identity; display name ไม่ใช่ identity
2. Webhook event เดียวต้องไม่สร้าง response มากกว่าหนึ่งครั้ง
3. โมเดลไม่มีสิทธิ์เปลี่ยน authorization, retention หรือ prohibited topics
4. Persona fact ทุกตัวต้องย้อนกลับไปหา observation ได้อย่างน้อยหนึ่งตัว
5. Unsend ต้องทำให้ข้อความและหลักฐานนั้นใช้ต่อไม่ได้
6. `ลืมฉัน` ไม่เท่ากับ memory opt-out
7. Member leave ไม่ลบ persona
8. Ambient reply ที่ reply token เก่าเกิน safety margin ต้อง expire ไม่ใช้ push fallback
9. ข้อมูลอ่อนไหวต้องไม่ถูกพูดออกมา แม้อยู่ใน persona
10. เมื่อ Safety Gate ไม่แน่ใจ ให้เลือกไม่ตอบ ambient message
