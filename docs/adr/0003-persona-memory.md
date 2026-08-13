# ADR-0003: Persona แบบ observations และ resolved facts

สถานะ: Accepted  
วันที่: 2026-08-13

## Context

ความชอบและพฤติกรรมเปลี่ยนได้ ข้อมูลจากเจ้าตัวกับคำบอกเล่าของคนอื่นมีความน่าเชื่อถือต่างกัน และ small model อาจสกัดผิด

## Decision

เก็บหลักฐานเป็น `persona_observations` และสร้างข้อสรุป `persona_facts` แยกกัน ข้อมูลจากเจ้าตัวมีน้ำหนักสูงกว่าพฤติกรรมอนุมานและคำบอกเล่าของคนอื่น Explicit correction มีน้ำหนักสูงสุด Facts มี confidence, timestamps, visibility และ links กลับไปยัง observations

ไม่ใช้ vector database หรือ embeddings ดึงความจำด้วย member/category/confidence จาก PostgreSQL

LINE `userId` เป็น canonical identity และ aliases ใช้แก้ชื่อเล่นหลายรูปแบบ การ resolve ที่ไม่มั่นใจห้ามผูก fact

## Consequences

- ตรวจได้ว่า bot เชื่อ fact จากอะไร
- แก้ความขัดแย้งและ unsend ได้โดยไม่สูญเสียประวัติภายใน retention
- schema และ resolver ซับซ้อนกว่าเก็บ summary ก้อนเดียว แต่ลด hallucinated identity
- facts ที่เก่า 180 วันลด confidence หรือ archive
- สมาชิกออกจากกลุ่มแล้ว persona ยังอยู่ตามการตัดสินใจของเจ้าของระบบ
