// 한국 시간(KST) 기준 오늘 날짜(YYYY-MM-DD) 반환
export function getTodayKST() {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstDate = new Date(now.getTime() + kstOffset);
  return kstDate.toISOString().split('T')[0];
}

// 오늘부터 7일 후까지 총 8일의 날짜 배열 생성 (표기: 월/일(요일))
export function getNext8Days() {
  const days = [];
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const todayStr = getTodayKST();
  const [y, m, d] = todayStr.split('-').map(Number);

  for (let i = 0; i < 8; i++) {
    const dateObj = new Date(Date.UTC(y, m - 1, d + i));
    const yyyy = dateObj.getUTCFullYear();
    const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getUTCDate()).padStart(2, '0');
    const dayName = dayNames[dateObj.getUTCDay()];

    days.push({
      dateStr: `${yyyy}-${mm}-${dd}`,
      label: `${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}(${dayName})`,
      isToday: i === 0,
    });
  }
  return days;
}

// 10자리 숫자 학번 검증
export function isValidStudentId(id) {
  return /^\d{10}$/.test(String(id).trim());
}

// 4자리 숫자 비밀번호 검증
export function isValidPin(pin) {
  return /^\d{4}$/.test(String(pin).trim());
}

// 모드별 30분 단위 타임슬롯 목록 생성
// reading_room: 00:00 ~ 24:00 (48개 슬롯)
// study_room: 12:00 ~ 22:00 (20개 슬롯)
export function generateTimeSlots(mode) {
  const startHour = mode === 'reading_room' ? 0 : 12;
  const endHour = mode === 'reading_room' ? 24 : 22;
  const slots = [];

  for (let h = startHour; h < endHour; h++) {
    for (let m of [0, 30]) {
      const start = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const nextM = m === 0 ? 30 : 0;
      const nextH = m === 0 ? h : h + 1;
      const end = `${String(nextH).padStart(2, '0')}:${String(nextM).padStart(2, '0')}`;
      slots.push({ start, end });
    }
  }
  return slots;
}

// 특정 날짜의 슬롯이 이미 지난 시간인지 확인 (KST 기준)
export function isSlotPast(dateStr, slotEndTime) {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  const currentDateStr = kstNow.toISOString().split('T')[0];

  if (dateStr < currentDateStr) return true;
  if (dateStr > currentDateStr) return false;

  const currentHHMM = kstNow.toISOString().split('T')[1].slice(0, 5);
  return slotEndTime <= currentHHMM;
}

// 현재 이용 중인 예약인지 판별 (조기 퇴실 버튼 활성화용)
export function isReservationInProgress(dateStr, startTime, endTime) {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  const currentDateStr = kstNow.toISOString().split('T')[0];

  if (dateStr !== currentDateStr) return false;

  const currentHHMM = kstNow.toISOString().split('T')[1].slice(0, 5);
  return currentHHMM >= startTime && currentHHMM < endTime;
}

// 좌석 구조 정의 (테이블 A, B, C / 1~12번 연속 번호)
export const TABLES = [
  { name: '테이블 A', seats: ['A-1', 'A-2', 'A-3', 'A-4'] },
  { name: '테이블 B', seats: ['B-5', 'B-6', 'B-7', 'B-8'] },
  { name: '테이블 C', seats: ['C-9', 'C-10', 'C-11', 'C-12'] },
];