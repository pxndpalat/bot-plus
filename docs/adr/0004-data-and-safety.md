# ADR-0004: Data lifecycle, member controls และ Safety Gate

สถานะ: Accepted  
วันที่: 2026-08-13

## Context

ระบบวิเคราะห์บทสนทนาจริงและนำ persona มาแซวในกลุ่ม สมาชิกจะได้รับการแจ้งว่ามี memory แต่ไม่มี consent workflow แบบกดยืนยัน ผู้ดูแลยอมให้ debug logs มีข้อความและ persona

## Decision

- raw messages เก็บ 30 วัน
- content logs เก็บ 7 วันและ rotate
- facts ลด confidence หลังไม่มีหลักฐานใหม่ 180 วัน
- `ลืมฉัน` ลบข้อมูลปัจจุบัน แต่เรียนรู้ใหม่จากข้อความถัดไปได้
- `หยุดวิเคราะห์ฉัน` เป็น long-term opt-out แยกต่างหาก
- สมาชิกดู/แก้/ลบข้อมูลตนเองได้ Admin ระบุด้วย LINE `userId`
- แซว persona ทั่วไปและเรื่องความสัมพันธ์ได้
- ห้ามกล่าวถึงสุขภาพ บาดแผล ศาสนา การเมือง เพศวิถี การเงิน ความลับ การกระทำผิดกฎหมาย ตำแหน่ง real-time และเนื้อหาโจมตีรุนแรง
- command และ authorization ตรวจด้วยโค้ด ข้อความกลุ่มไม่สามารถ override policy
- secret และ authorization header ห้ามลง log
- ไม่มี backup

## Consequences

- ระบบมี transparency/control ขั้นพื้นฐานโดยไม่เพิ่ม consent state machine
- `ลืมฉัน` ไม่ป้องกันการเรียนรู้ซ้ำ ผู้ใช้ต้องใช้ opt-out หากต้องการหยุดจริง
- content logs ช่วย debug แต่เพิ่มผลกระทบหากเครื่องถูกเข้าถึง จึงต้องจำกัดสิทธิ์และลบใน 7 วัน
- Safety Gate อาจปฏิเสธมุกที่จริง ๆ ปลอดภัย; สำหรับ ambient path ความเงียบเป็นผลลัพธ์ที่ยอมรับได้
