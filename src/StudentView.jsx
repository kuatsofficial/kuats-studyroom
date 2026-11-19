import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import {
  getNext8Days,
  isValidStudentId,
  isValidPin,
  generateTimeSlots,
  isSlotPast,
  isReservationInProgress,
  TABLES,
} from './utils';
import {
  Calendar,
  Clock,
  UserCheck,
  Users,
  Lock,
  LogOut,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

const READING_ROOM_COOLDOWN_MS = 10 * 60 * 1000;

// "HH:MM:SS" 또는 "HH:MM" -> "HH:MM"으로 통일
function formatHHMM(timeStr) {
  if (!timeStr) return '00:00';
  return String(timeStr).slice(0, 5);
}

// "HH:MM" -> 자정(00:00) 기준 분(minutes) 변환 ("24:00" 지원)
function timeToMinutes(hhmm) {
  const clean = formatHHMM(hhmm);
  if (clean === '24:00') return 24 * 60;
  const [h, m] = clean.split(':').map(Number);
  return h * 60 + m;
}

// 이용 시간 옵션 생성 (30분 단위, 최대 maxHours 시간)
function buildDurationOptions(maxHours = 4) {
  const options = [];
  const maxSlots = maxHours * 2;
  for (let slots = 1; slots <= maxSlots; slots++) {
    const minutes = slots * 30;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    let label = '';
    if (h > 0 && m > 0) label = `${h}시간 ${m}분`;
    else if (h > 0) label = `${h}시간`;
    else label = `${m}분`;
    options.push({ slots, minutes, label });
  }
  return options;
}

// "HH:MM" + slots(30분 단위) -> "HH:MM" 계산
function addSlotsToTime(startHHMM, slots) {
  const totalMinutes = timeToMinutes(startHHMM) + slots * 30;
  if (totalMinutes === 24 * 60) return '24:00';
  const endH = Math.floor(totalMinutes / 60);
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

// 열람실 모드 취소 건이 10분 잠금(쿨다운) 상태인지 확인
function isReadingRoomCooldownActive(record, nowMs = Date.now()) {
  if (!record || record.mode !== 'reading_room' || record.status !== 'cancelled') {
    return false;
  }
  if (!record.cancelled_at) return false;
  const cancelledAtMs = new Date(record.cancelled_at).getTime();
  if (Number.isNaN(cancelledAtMs)) return false;
  return nowMs - cancelledAtMs < READING_ROOM_COOLDOWN_MS;
}

export default function StudentView({ onSwitchToAdmin }) {
  // 로그인 / 회원가입 탭 상태
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'signup'
  const [inputName, setInputName] = useState('');
  const [inputStudentId, setInputStudentId] = useState('');
  const [inputDepartment, setInputDepartment] = useState('');

  const [studentInfo, setStudentInfo] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const days = useMemo(() => getNext8Days(), []);
  const [selectedDate, setSelectedDate] = useState(days[0].dateStr);
  const [currentMode, setCurrentMode] = useState('study_room'); // 기본값은 항상 스터디룸 모드
  const [selectedSeat, setSelectedSeat] = useState('A-1');
  const [publicReservations, setPublicReservations] = useState([]);
  const [myReservations, setMyReservations] = useState([]);
  const [loadingData, setLoadingData] = useState(false);

  const [startTime, setStartTime] = useState('12:00');
  const [durationSlots, setDurationSlots] = useState(2);

  const [showBookingModal, setShowBookingModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [companionIdsText, setCompanionIdsText] = useState('');
  const [totalHeadcount, setTotalHeadcount] = useState(2);
  const [purpose, setPurpose] = useState('');
  const [bookingError, setBookingError] = useState('');
  const [bookingSubmitting, setBookingSubmitting] = useState(false);

  const [actionModal, setActionModal] = useState(null);
  const [actionPin, setActionPin] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionSubmitting, setActionSubmitting] = useState(false);

  // 로그인 처리 (이름 + 학번)
  const handleStudentLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginMessage('');

    const trimmedName = inputName.trim();
    const trimmedId = inputStudentId.trim();

    if (!trimmedName) {
      setLoginError('이름을 입력해 주세요.');
      return;
    }
    if (!isValidStudentId(trimmedId)) {
      setLoginError('학번은 숫자 10자리로 정확히 입력해 주세요. (예: 2026010123)');
      return;
    }

    setLoginLoading(true);
    try {
      const { data: profile, error } = await supabase
        .from('member_profiles')
        .select('*')
        .eq('student_id', trimmedId)
        .maybeSingle();

      if (error) throw error;

      if (!profile) {
        setLoginError('가입 내역이 없는 학번입니다. 먼저 [회원가입 신청] 탭에서 신청해 주세요.');
        return;
      }

      if (profile.name.trim() !== trimmedName) {
        setLoginError('입력하신 이름과 해당 학번의 등록된 이름이 일치하지 않습니다.');
        return;
      }

      setStudentInfo({
        name: profile.name,
        studentId: profile.student_id,
        department: profile.department,
        status: profile.status, // 'pending' | 'associate' | 'regular' | 'rejected'
        isRegular: profile.status === 'regular',
      });
    } catch (err) {
      setLoginError('접속 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setLoginLoading(false);
    }
  };

  // 회원가입 신청 처리 (이름 + 학번 + 학과/학부 -> pending 상태로 저장)
  const handleStudentSignup = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginMessage('');

    const trimmedName = inputName.trim();
    const trimmedId = inputStudentId.trim();
    const trimmedDept = inputDepartment.trim();

    if (!trimmedName) {
      setLoginError('이름을 입력해 주세요.');
      return;
    }
    if (!isValidStudentId(trimmedId)) {
      setLoginError('학번은 숫자 10자리로 정확히 입력해 주세요. (예: 2026010123)');
      return;
    }
    if (!trimmedDept) {
      setLoginError('학과 또는 학부를 입력해 주세요.');
      return;
    }

    setLoginLoading(true);
    try {
      const { data: existing } = await supabase
        .from('member_profiles')
        .select('student_id, status')
        .eq('student_id', trimmedId)
        .maybeSingle();

      if (existing) {
        if (existing.status === 'pending') {
          setLoginError('이미 회원가입 신청이 접수되어 관리자 승인 대기 중인 학번입니다.');
        } else if (existing.status === 'associate' || existing.status === 'regular') {
          setLoginError('이미 승인 완료된 학번입니다. [로그인] 탭에서 바로 입장해 주세요.');
        } else {
          setLoginError('이미 신청 이력이 있는 학번입니다. 관리자에게 문의해 주세요.');
        }
        return;
      }

      const { error: insertErr } = await supabase.from('member_profiles').insert([
        {
          student_id: trimmedId,
          name: trimmedName,
          department: trimmedDept,
          status: 'pending',
        },
      ]);

      if (insertErr) throw insertErr;

      setInputDepartment('');
      setAuthMode('login');
      setLoginMessage(
        `[${trimmedName} / ${trimmedDept}] 회원가입 신청이 완료되었습니다! 편입연 관리자 확인 및 승인 후 로그인하실 수 있습니다.`
      );
    } catch (err) {
      setLoginError('회원가입 신청 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setStudentInfo(null);
    setLoginError('');
    setLoginMessage('');
  };

  const fetchScheduleAndReservations = async () => {
    if (!studentInfo || (studentInfo.status !== 'associate' && studentInfo.status !== 'regular')) {
      return;
    }
    setLoadingData(true);

    try {
      const { data: modeData, error: modeErr } = await supabase
        .from('daily_modes')
        .select('mode')
        .eq('date', selectedDate)
        .maybeSingle();

      if (modeErr) throw modeErr;
      // 열람실 모드로 지정되지 않은 날짜는 기본으로 무조건 스터디룸 모드
      const resolvedMode = modeData?.mode === 'reading_room' ? 'reading_room' : 'study_room';
      setCurrentMode(resolvedMode);

      const defaultStart = resolvedMode === 'reading_room' ? '09:00' : '12:00';
      setStartTime(defaultStart);
      setDurationSlots(2);

      if (resolvedMode === 'study_room') {
        setSelectedSeat('ROOM-ALL');
      } else if (selectedSeat === 'ROOM-ALL') {
        setSelectedSeat('A-1');
      }

      const nowMs = Date.now();
      const { data: pubData, error: pubErr } = await supabase
        .from('public_reservations')
        .select('*')
        .eq('date', selectedDate);

      if (!pubErr && pubData) {
        const filteredPub = pubData.filter(
          (r) => r.status === 'active' || isReadingRoomCooldownActive(r, nowMs)
        );
        setPublicReservations(filteredPub);
      } else {
        const { data: fallbackData } = await supabase
          .from('reservations')
          .select('id, date, mode, seat_id, start_time, end_time, status, cancelled_at')
          .eq('date', selectedDate);

        const filteredFallback = (fallbackData || []).filter(
          (r) => r.status === 'active' || isReadingRoomCooldownActive(r, nowMs)
        );
        setPublicReservations(filteredFallback);
      }

      const todayStr = days[0].dateStr;
      const { data: myData } = await supabase
        .from('reservations')
        .select('id, date, mode, seat_id, start_time, end_time, total_headcount, purpose, status')
        .eq('student_id', studentInfo.studentId)
        .eq('status', 'active')
        .gte('date', todayStr)
        .order('date', { ascending: true })
        .order('start_time', { ascending: true });

      setMyReservations(myData || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    fetchScheduleAndReservations();
  }, [studentInfo, selectedDate]);

  const timeSlots = useMemo(() => generateTimeSlots(currentMode), [currentMode]);
  const operatingStartTime = currentMode === 'reading_room' ? '00:00' : '12:00';
  const operatingEndTime = currentMode === 'reading_room' ? '24:00' : '22:00';

  // 선택된 좌석/공간의 활성 예약 및 '열람실 모드 취소 후 10분 이내' 잠금 내역
  const currentSeatReservations = useMemo(() => {
    const nowMs = Date.now();
    return publicReservations
      .filter((r) => {
        if (r.seat_id !== selectedSeat) return false;
        if (r.status === 'active') return true;
        if (currentMode === 'reading_room' && isReadingRoomCooldownActive(r, nowMs)) {
          return true;
        }
        return false;
      })
      .map((r) => ({
        ...r,
        isCooldown: r.status === 'cancelled',
      }));
  }, [publicReservations, selectedSeat, currentMode]);

  const availableStartSlots = useMemo(() => {
    return timeSlots.filter((slot) => {
      const past = isSlotPast(selectedDate, slot.end);
      const reserved = currentSeatReservations.some(
        (r) =>
          formatHHMM(r.start_time) < slot.end &&
          formatHHMM(r.end_time) > slot.start
      );
      return !past && !reserved;
    });
  }, [timeSlots, selectedDate, currentSeatReservations]);

  useEffect(() => {
    if (availableStartSlots.length > 0) {
      const stillValid = availableStartSlots.some((s) => s.start === startTime);
      if (!stillValid) {
        setStartTime(availableStartSlots[0].start);
      }
    }
  }, [availableStartSlots, startTime]);

  const durationOptions = useMemo(() => {
    const maxHours =
      currentMode === 'reading_room' && studentInfo?.isRegular ? 12 : 4;
    return buildDurationOptions(maxHours);
  }, [currentMode, studentInfo]);

  const computedEndTime = useMemo(
    () => addSlotsToTime(startTime, durationSlots),
    [startTime, durationSlots]
  );

  const rangeValidation = useMemo(() => {
    if (!startTime || availableStartSlots.length === 0) {
      return { valid: false, reason: '예약 가능한 시작 시간이 없습니다.' };
    }
    if (computedEndTime > operatingEndTime) {
      return {
        valid: false,
        reason: `운영 종료 시각(${operatingEndTime})을 초과했습니다. 이용 시간을 줄여주세요.`,
      };
    }
    const overlaps = currentSeatReservations.some(
      (r) =>
        formatHHMM(r.start_time) < computedEndTime &&
        formatHHMM(r.end_time) > startTime
    );
    if (overlaps) {
      return {
        valid: false,
        reason:
          '선택한 시간 범위 중간에 이미 예약되었거나 취소 후 10분 대기 중인 시간이 포함되어 있습니다.',
      };
    }
    return { valid: true, reason: '' };
  }, [startTime, computedEndTime, operatingEndTime, currentSeatReservations, availableStartSlots]);

  const barStartMin = timeToMinutes(operatingStartTime);
  const barEndMin = timeToMinutes(operatingEndTime);
  const barTotalMin = barEndMin - barStartMin;

  const reservedBlocks = useMemo(() => {
    return currentSeatReservations
      .map((r) => {
        const sMin = Math.max(barStartMin, timeToMinutes(r.start_time));
        const eMin = Math.min(barEndMin, timeToMinutes(r.end_time));
        if (eMin <= sMin) return null;
        const leftPct = ((sMin - barStartMin) / barTotalMin) * 100;
        const widthPct = ((eMin - sMin) / barTotalMin) * 100;
        return {
          id: r.id,
          label: `${formatHHMM(r.start_time)}~${formatHHMM(r.end_time)}`,
          isCooldown: Boolean(r.isCooldown),
          leftPct,
          widthPct,
        };
      })
      .filter(Boolean);
  }, [currentSeatReservations, barStartMin, barEndMin, barTotalMin]);

  const handleOpenBookingModal = () => {
    if (!rangeValidation.valid) {
      alert(rangeValidation.reason);
      return;
    }

    if (currentMode === 'reading_room' && !studentInfo.isRegular) {
      const todayMySlots = myReservations
        .filter((r) => r.date === selectedDate && r.mode === 'reading_room')
        .reduce((acc, r) => {
          const diffMin = timeToMinutes(r.end_time) - timeToMinutes(r.start_time);
          return acc + diffMin / 30;
        }, 0);

      if (todayMySlots + durationSlots > 8) {
        alert(
          `준회원은 열람실을 하루 최대 4시간(8칸)까지만 예약할 수 있습니다.\n(현재 해당 날짜 기예약: ${todayMySlots * 0.5}시간)`
        );
        return;
      }
    }

    if (currentMode === 'study_room' && durationSlots > 8) {
      alert('스터디룸은 1회 및 하루 최대 4시간까지만 예약할 수 있습니다.');
      return;
    }

    const hasOverlap = myReservations.some(
      (r) =>
        r.date === selectedDate &&
        formatHHMM(r.start_time) < computedEndTime &&
        formatHHMM(r.end_time) > startTime
    );
    if (hasOverlap) {
      alert('동일한 시간대에 이미 다른 좌석(또는 스터디룸) 예약 내역이 있어 중복 예약할 수 없습니다.');
      return;
    }

    setBookingError('');
    setPinInput('');
    setCompanionIdsText('');
    setTotalHeadcount(2);
    setPurpose('');
    setShowBookingModal(true);
  };

  const handleConfirmBooking = async (e) => {
    e.preventDefault();
    setBookingError('');
    if (!rangeValidation.valid) return;

    if (!isValidPin(pinInput)) {
      setBookingError('취소·퇴실 확인용 일회성 비밀번호는 숫자 4자리로 입력해 주세요.');
      return;
    }

    let companionList = [];
    if (currentMode === 'study_room') {
      companionList = companionIdsText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (companionList.length < 1) {
        setBookingError('스터디룸은 대표자 외 최소 1명 이상의 동반자 학번을 입력해야 합니다. (총 2인 이상)');
        return;
      }

      for (const cid of companionList) {
        if (!isValidStudentId(cid)) {
          setBookingError(`동반자 학번(${cid})이 올바르지 않습니다. 숫자 10자리로 입력해 주세요.`);
          return;
        }
        if (cid === studentInfo.studentId) {
          setBookingError('동반자 학번에 본인 학번을 중복 입력할 수 없습니다.');
          return;
        }
      }

      if (Number(totalHeadcount) < 2) {
        setBookingError('총 사용 인원수는 최소 2명 이상이어야 합니다.');
        return;
      }

      if (!purpose.trim()) {
        setBookingError('스터디룸 사용 목적을 입력해 주세요.');
        return;
      }

      const allIds = [studentInfo.studentId, ...companionList];
      const { data: regList, error: regErr } = await supabase
        .from('member_profiles')
        .select('student_id')
        .in('student_id', allIds)
        .eq('status', 'regular');

      if (regErr) {
        setBookingError('정회원 자격 확인 중 오류가 발생했습니다.');
        return;
      }

      if (!regList || regList.length === 0) {
        setBookingError(
          '스터디룸 예약 조건 미달: 대표자와 동반자 중 최소 1명은 반드시 정회원이어야 합니다.'
        );
        return;
      }

      const todayStudySlots = myReservations
        .filter((r) => r.date === selectedDate && r.mode === 'study_room')
        .reduce((acc, r) => {
          const diffMin = timeToMinutes(r.end_time) - timeToMinutes(r.start_time);
          return acc + diffMin / 30;
        }, 0);

      if (todayStudySlots + durationSlots > 8) {
        setBookingError('스터디룸은 하루 최대 4시간까지만 이용할 수 있습니다.');
        return;
      }
    }

    setBookingSubmitting(true);
    try {
      // 활성 예약 충돌 확인
      const { data: conflictCheck } = await supabase
        .from('reservations')
        .select('id')
        .eq('date', selectedDate)
        .eq('seat_id', selectedSeat)
        .eq('status', 'active')
        .lt('start_time', computedEndTime)
        .gt('end_time', startTime);

      if (conflictCheck && conflictCheck.length > 0) {
        setBookingError('방금 다른 사용자가 먼저 해당 시간을 예약했습니다. 새로고침 후 다시 선택해 주세요.');
        setBookingSubmitting(false);
        return;
      }

      // 열람실 모드 동일 좌석 10분 쿨다운 충돌 확인
      if (currentMode === 'reading_room') {
        const cooldownCutoffISO = new Date(Date.now() - READING_ROOM_COOLDOWN_MS).toISOString();
        const { data: cooldownCheck } = await supabase
          .from('reservations')
          .select('id')
          .eq('date', selectedDate)
          .eq('mode', 'reading_room')
          .eq('seat_id', selectedSeat)
          .eq('status', 'cancelled')
          .gt('cancelled_at', cooldownCutoffISO)
          .lt('start_time', computedEndTime)
          .gt('end_time', startTime);

        if (cooldownCheck && cooldownCheck.length > 0) {
          setBookingError(
            `취소된 [${selectedSeat}] 좌석은 취소 후 10분간 동일 좌석 예약이 제한됩니다.`
          );
          setBookingSubmitting(false);
          return;
        }
      }

      const payload = {
        date: selectedDate,
        mode: currentMode,
        seat_id: selectedSeat,
        start_time: startTime,
        end_time: computedEndTime,
        student_id: studentInfo.studentId,
        student_name: studentInfo.name,
        companion_ids: currentMode === 'study_room' ? companionList : [],
        total_headcount: currentMode === 'study_room' ? Number(totalHeadcount) : 1,
        purpose: currentMode === 'study_room' ? purpose.trim() : '개인 열람실 이용',
        temp_password: pinInput.trim(),
        status: 'active',
      };

      const { error: insertErr } = await supabase.from('reservations').insert([payload]);
      if (insertErr) throw insertErr;

      alert('예약이 완료되었습니다! 취소 또는 조기 퇴실 시 방금 입력한 4자리 비밀번호가 필요합니다.');
      setShowBookingModal(false);
      fetchScheduleAndReservations();
    } catch (err) {
      setBookingError('예약 저장 실패: ' + err.message);
    } finally {
      setBookingSubmitting(false);
    }
  };

  const handleExecuteAction = async (e) => {
    e.preventDefault();
    setActionError('');
    if (!isValidPin(actionPin)) {
      setActionError('예약 시 설정한 숫자 4자리 비밀번호를 입력해 주세요.');
      return;
    }

    const target = actionModal.reservation;
    setActionSubmitting(true);

    try {
      if (actionModal.type === 'cancel') {
        const cancelledAtISO = new Date().toISOString();
        const { data: verifyRow } = await supabase
          .from('reservations')
          .select('id, temp_password, status')
          .eq('id', target.id)
          .single();

        if (!verifyRow || verifyRow.status !== 'active') {
          setActionError('이미 취소되었거나 존재하지 않는 예약입니다.');
          setActionSubmitting(false);
          return;
        }

        if (verifyRow.temp_password !== actionPin.trim()) {
          setActionError('비밀번호가 일치하지 않습니다.');
          setActionSubmitting(false);
          return;
        }

        const { error: updErr } = await supabase
          .from('reservations')
          .update({ status: 'cancelled', cancelled_at: cancelledAtISO })
          .eq('id', target.id);
        if (updErr) throw updErr;

        alert(
          target.mode === 'reading_room'
            ? `예약이 취소되었습니다. [${target.seat_id}] 좌석은 10분간 동일 좌석 예약이 제한됩니다.`
            : '예약이 정상적으로 취소되었습니다.'
        );
      } else if (actionModal.type === 'early_exit') {
        const now = new Date();
        const kstOffset = 9 * 60 * 60 * 1000;
        const kstNow = new Date(now.getTime() + kstOffset);
        const curH = kstNow.getUTCHours();
        const curM = kstNow.getUTCMinutes();

        const nextEndH = curM < 30 ? curH : curH + 1;
        const nextEndM = curM < 30 ? 30 : 0;
        const newEndTime = `${String(nextEndH).padStart(2, '0')}:${String(nextEndM).padStart(2, '0')}`;

        const { data: rpcExit, error: rpcExitErr } = await supabase.rpc('early_checkout_with_pin', {
          p_reservation_id: target.id,
          p_pin: actionPin.trim(),
          p_new_end_time: newEndTime,
        });

        if (rpcExitErr) {
          const { data: verifyRow } = await supabase
            .from('reservations')
            .select('id, temp_password, start_time, end_time')
            .eq('id', target.id)
            .single();

          if (!verifyRow || verifyRow.temp_password !== actionPin.trim()) {
            setActionError('비밀번호가 일치하지 않습니다.');
            setActionSubmitting(false);
            return;
          }

          if (newEndTime < formatHHMM(verifyRow.end_time)) {
            await supabase
              .from('reservations')
              .update({ end_time: newEndTime })
              .eq('id', target.id);
          } else {
            await supabase
              .from('reservations')
              .update({ status: 'completed' })
              .eq('id', target.id);
          }
        } else if (rpcExit === false) {
          setActionError('비밀번호가 일치하지 않습니다.');
          setActionSubmitting(false);
          return;
        }

        alert(`실시간 퇴실 처리가 완료되었습니다. (${newEndTime} 이후 잔여 시간이 빈자리로 반환되었습니다.)`);
      }

      setActionModal(null);
      setActionPin('');
      fetchScheduleAndReservations();
    } catch (err) {
      setActionError('처리 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setActionSubmitting(false);
    }
  };

  // [화면 1] 로그인 / 회원가입 신청 화면
  if (!studentInfo) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
          <div className="text-center mb-5">
            <span className="inline-block px-3 py-1 bg-rose-50 text-rose-700 text-xs font-bold rounded-full mb-2">
              편입연 공간 통합 예약 시스템
            </span>
            <h1 className="text-2xl font-extrabold text-slate-900">열람실 · 스터디룸 예약</h1>
            <p className="text-xs text-slate-500 mt-1">
              {authMode === 'login'
                ? '승인된 회원은 이름과 10자리 학번으로 바로 입장할 수 있습니다.'
                : '이름·학번·학과/학부를 입력해 가입 신청하면 관리자 확인 후 준회원으로 등록됩니다.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl mb-5">
            <button
              type="button"
              onClick={() => {
                setAuthMode('login');
                setLoginError('');
              }}
              className={`py-2 text-xs font-bold rounded-lg transition ${
                authMode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
              }`}
            >
              로그인
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode('signup');
                setLoginError('');
                setLoginMessage('');
              }}
              className={`py-2 text-xs font-bold rounded-lg transition ${
                authMode === 'signup' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
              }`}
            >
              회원가입 신청
            </button>
          </div>

          <form
            onSubmit={authMode === 'login' ? handleStudentLogin : handleStudentSignup}
            className="space-y-3.5"
          >
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">이름</label>
              <input
                type="text"
                required
                placeholder="홍길동"
                value={inputName}
                onChange={(e) => setInputName(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                학번 (숫자 10자리)
              </label>
              <input
                type="text"
                required
                maxLength={10}
                placeholder="2026010123"
                value={inputStudentId}
                onChange={(e) => setInputStudentId(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none tracking-wider"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                입력된 자릿수: {inputStudentId.length} / 10자리
              </p>
            </div>

            {authMode === 'signup' && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">학과 / 학부</label>
                <input
                  type="text"
                  required
                  placeholder="예: 경영학과, 컴퓨터학과, 자유전공학부"
                  value={inputDepartment}
                  onChange={(e) => setInputDepartment(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>
            )}

            {loginMessage && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 leading-relaxed">
                {loginMessage}
              </div>
            )}

            {loginError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm transition shadow-sm"
            >
              {loginLoading
                ? '확인 중...'
                : authMode === 'login'
                ? '입장하기'
                : '회원가입 신청하기'}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-100 text-center">
            <button
              type="button"
              onClick={onSwitchToAdmin}
              className="text-xs text-slate-400 hover:text-slate-600 underline"
            >
              편입연 관리자 페이지로 이동
            </button>
          </div>
        </div>
      </div>
    );
  }

  // [화면 1-2] 승인 대기 / 반려 안내 화면
  if (studentInfo.status !== 'associate' && studentInfo.status !== 'regular') {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-slate-200 p-8 text-center space-y-4">
          <div className="inline-flex px-3 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-bold">
            {studentInfo.status === 'pending' ? '가입 승인 대기 중' : '가입 승인 반려'}
          </div>
          <h2 className="text-xl font-extrabold text-slate-900">
            {studentInfo.name} ({studentInfo.studentId})
          </h2>
          <p className="text-xs font-semibold text-slate-500">
            신청 학과/학부: {studentInfo.department}
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            {studentInfo.status === 'pending'
              ? '현재 편입연 관리자가 학번 및 학과/학부 정보를 확인 중입니다. 승인 완료 시 기본 [준회원] 등급으로 예약 시스템을 이용하실 수 있습니다.'
              : '가입 승인이 반려되었습니다. 편입연 관리자에게 문의해 주세요.'}
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full py-2.5 bg-slate-900 text-white text-xs font-bold rounded-xl"
          >
            돌아가기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-extrabold text-slate-900">편입연 공간 예약</h1>
            {studentInfo.isRegular ? (
              <span className="px-2.5 py-0.5 bg-indigo-100 text-indigo-800 text-xs font-bold rounded-full flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5" /> 정회원 (열람실 무제한)
              </span>
            ) : (
              <span className="px-2.5 py-0.5 bg-amber-100 text-amber-800 text-xs font-bold rounded-full">
                준회원 (열람실 일 4시간 제한)
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-slate-700">
              {studentInfo.name} ({studentInfo.studentId} · {studentInfo.department})
            </span>
            <button
              onClick={handleLogout}
              className="px-2.5 py-1 text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 mt-6 space-y-6">
        {/* 1. 날짜 선택 */}
        <section className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-slate-700 flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-emerald-600" /> 예약 날짜 선택 (최대 7일 전 예약 가능)
            </h2>
            <button
              onClick={fetchScheduleAndReservations}
              className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" /> 새로고침
            </button>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {days.map((d) => {
              const active = d.dateStr === selectedDate;
              return (
                <button
                  key={d.dateStr}
                  onClick={() => setSelectedDate(d.dateStr)}
                  className={`py-2.5 px-2 rounded-xl text-xs font-bold border transition ${
                    active
                      ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div>{d.label}</div>
                  {d.isToday && (
                    <span className={`text-[10px] ${active ? 'text-emerald-300' : 'text-emerald-600'}`}>
                      오늘
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div
            className={`mt-4 p-3.5 rounded-xl border flex flex-wrap items-center justify-between gap-2 ${
              currentMode === 'reading_room'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-sky-50 border-sky-200 text-sky-900'
            }`}
          >
            <div>
              <span className="text-xs font-extrabold uppercase tracking-wider px-2 py-0.5 rounded bg-white/80 mr-2">
                {currentMode === 'reading_room' ? '열람실 모드 (개인석 12자리)' : '스터디룸 모드 (방 전체 대관)'}
              </span>
              <span className="text-sm font-semibold">
                {currentMode === 'reading_room'
                  ? '운영시간: 24시간 개방 (00:00 ~ 24:00) · 1인 1좌석 예약 · 취소 시 동일 좌석 10분 잠금'
                  : '운영시간: 12:00 ~ 22:00 · 2인 이상(정회원 1인 필수) · 최대 4시간'}
              </span>
            </div>
          </div>
        </section>

        {/* 2. 열람실 좌석 선택 */}
        {currentMode === 'reading_room' && (
          <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
            <h2 className="text-sm font-bold text-slate-700 mb-3">
              좌석 선택 (테이블별 4석 · 총 12석)
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {TABLES.map((table) => (
                <div
                  key={table.name}
                  className="p-4 rounded-xl bg-slate-50 border border-slate-200"
                >
                  <div className="text-center text-xs font-bold text-slate-500 mb-3 pb-1.5 border-b border-slate-200">
                    {table.name}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {table.seats.map((seat) => {
                      const isSelected = selectedSeat === seat;
                      return (
                        <button
                          key={seat}
                          onClick={() => setSelectedSeat(seat)}
                          className={`py-3 rounded-xl font-extrabold text-sm border-2 transition ${
                            isSelected
                              ? 'bg-slate-900 text-white border-slate-900 shadow-md'
                              : 'bg-white text-slate-700 border-slate-200 hover:border-emerald-400'
                          }`}
                        >
                          {seat}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 3. 타임라인 바 + [시작 시간 + 이용 시간] 선택 */}
        <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-emerald-600" />
              {currentMode === 'reading_room'
                ? `[${selectedSeat}] 24시간 예약 현황 및 시간 선택`
                : '[스터디룸 전체] 운영시간(12:00~22:00) 예약 현황 및 시간 선택'}
            </h2>

            <div className="flex items-center gap-3 text-xs font-semibold">
              <span className="flex items-center gap-1">
                <span className="w-3.5 h-3.5 rounded bg-emerald-500 inline-block" /> 빈자리(예약 가능)
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3.5 h-3.5 rounded bg-gray-300 inline-block" /> 예약됨
              </span>
              {currentMode === 'reading_room' && (
                <span className="flex items-center gap-1">
                  <span className="w-3.5 h-3.5 rounded bg-amber-300 inline-block" /> 취소 후 10분 대기
                </span>
              )}
            </div>
          </div>

          {/* 1시간 단위 칸 구분선 위에 정확히 시간 숫자가 놓이는 타임라인 바 */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            {loadingData ? (
              <div className="h-12 rounded-xl bg-slate-200 animate-pulse" />
            ) : (
              <div className="overflow-x-auto pb-1">
                <div className="min-w-[680px]">
                  <div className="relative h-5 text-[11px] font-bold text-slate-600 mb-1 select-none">
                    {Array.from(
                      {
                        length:
                          (currentMode === 'reading_room' ? 24 : 10) + 1,
                      },
                      (_, idx) => {
                        const totalCols =
                          currentMode === 'reading_room' ? 24 : 10;
                        const hourVal =
                          (currentMode === 'reading_room' ? 0 : 12) + idx;
                        const pct = (idx / totalCols) * 100;
                        const posClass =
                          idx === 0
                            ? 'left-0 translate-x-0'
                            : idx === totalCols
                            ? 'right-0 translate-x-0'
                            : '-translate-x-1/2';
                        return (
                          <span
                            key={hourVal}
                            style={
                              idx === totalCols ? undefined : { left: `${pct}%` }
                            }
                            className={`absolute top-0 ${posClass} tabular-nums`}
                          >
                            {String(hourVal).padStart(2, '0')}
                          </span>
                        );
                      }
                    )}
                  </div>

                  <div
                    className="relative grid rounded-xl overflow-hidden border border-emerald-600 bg-emerald-500"
                    style={{
                      gridTemplateColumns: `repeat(${
                        currentMode === 'reading_room' ? 24 : 10
                      }, minmax(0, 1fr))`,
                    }}
                  >
                    {Array.from(
                      { length: currentMode === 'reading_room' ? 24 : 10 },
                      (_, idx) => (
                        <div
                          key={idx}
                          className="h-10 border-r last:border-r-0 border-emerald-700/40"
                        />
                      )
                    )}

                    {reservedBlocks.map((blk) => (
                      <button
                        key={blk.id}
                        type="button"
                        onClick={() =>
                          alert(
                            blk.isCooldown
                              ? `[취소 후 10분 대기] ${blk.label} 시간대는 해당 좌석 취소 후 10분간 예약할 수 없습니다.`
                              : `[예약됨] ${blk.label} 시간대는 이미 예약되어 있습니다.`
                          )
                        }
                        style={{
                          left: `${blk.leftPct}%`,
                          width: `${Math.max(blk.widthPct, 2)}%`,
                        }}
                        className={`absolute top-0 bottom-0 border-x flex items-center justify-center text-[11px] font-extrabold truncate px-1 cursor-pointer transition z-10 ${
                          blk.isCooldown
                            ? 'bg-amber-300/95 hover:bg-amber-400 text-amber-950 border-amber-600/50'
                            : 'bg-gray-300/95 hover:bg-gray-400 text-gray-800 border-gray-500/50'
                        }`}
                        title={
                          blk.isCooldown
                            ? `${blk.label} 취소 후 10분 대기`
                            : `${blk.label} 예약됨`
                        }
                      >
                        {blk.widthPct >= 10
                          ? blk.isCooldown
                            ? `10분 대기 (${blk.label})`
                            : `예약됨 (${blk.label})`
                          : blk.isCooldown
                          ? '10분 대기'
                          : '예약됨'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-500">
              - 구분선 위 숫자가 각 시각(00~24시 또는 12~22시)이며, 초록색은 빈자리, 회색은 예약됨, 노란색은 열람실 취소 후 10분 대기 시간입니다.
            </p>
          </div>

          {/* 시작 시간 & 이용 시간 선택 컨트롤 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">1. 시작 시간</label>
              <select
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={availableStartSlots.length === 0}
                className="w-full px-3.5 py-2.5 text-sm font-bold border border-slate-300 rounded-xl bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              >
                {availableStartSlots.length === 0 ? (
                  <option value="">예약 가능한 시작 시간 없음</option>
                ) : (
                  availableStartSlots.map((slot) => (
                    <option key={slot.start} value={slot.start}>
                      {slot.start} 시작
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">2. 이용 시간 (몇 시간)</label>
              <select
                value={durationSlots}
                onChange={(e) => setDurationSlots(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 text-sm font-bold border border-slate-300 rounded-xl bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              >
                {durationOptions.map((opt) => (
                  <option key={opt.slots} value={opt.slots}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="p-4 bg-slate-900 text-white rounded-xl flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="text-emerald-400 font-bold mr-2">
                {currentMode === 'reading_room' ? selectedSeat : '스터디룸 전체'}
              </span>
              {rangeValidation.valid ? (
                <span>
                  예약 예정 시간: <strong>{startTime} ~ {computedEndTime}</strong> (총{' '}
                  {durationSlots * 0.5}시간)
                </span>
              ) : (
                <span className="text-rose-300 font-semibold">{rangeValidation.reason}</span>
              )}
            </div>

            <button
              type="button"
              onClick={handleOpenBookingModal}
              disabled={!rangeValidation.valid}
              className={`px-5 py-2.5 text-sm font-bold rounded-xl shadow transition ${
                rangeValidation.valid
                  ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                  : 'bg-slate-700 text-slate-400 cursor-not-allowed'
              }`}
            >
              예약 신청하기
            </button>
          </div>
        </section>

        {/* 4. 내 예약 내역 */}
        <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <h2 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" /> 내 활성 예약 내역 ({myReservations.length}건)
          </h2>

          {myReservations.length === 0 ? (
            <p className="text-xs text-slate-400 py-4 text-center">현재 예약된 내역이 없습니다.</p>
          ) : (
            <div className="space-y-2.5">
              {myReservations.map((res) => {
                const sHHMM = formatHHMM(res.start_time);
                const eHHMM = formatHHMM(res.end_time);
                const inProgress = isReservationInProgress(res.date, sHHMM, eHHMM);
                return (
                  <div
                    key={res.id}
                    className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold px-2 py-0.5 rounded bg-slate-800 text-white">
                          {res.mode === 'reading_room' ? `열람실 ${res.seat_id}` : '스터디룸 전체'}
                        </span>
                        <span className="text-sm font-extrabold text-slate-800">
                          {res.date} | {sHHMM} ~ {eHHMM}
                        </span>
                        {inProgress && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 animate-pulse">
                            현재 이용 중
                          </span>
                        )}
                      </div>
                      {res.mode === 'study_room' && (
                        <p className="text-xs text-slate-500 mt-1">
                          인원: {res.total_headcount}명 · 목적: {res.purpose}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {inProgress ? (
                        <button
                          onClick={() => {
                            setActionPin('');
                            setActionError('');
                            setActionModal({ type: 'early_exit', reservation: res });
                          }}
                          className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg flex items-center gap-1"
                        >
                          <LogOut className="w-3.5 h-3.5" /> 실시간 퇴실
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setActionPin('');
                            setActionError('');
                            setActionModal({ type: 'cancel', reservation: res });
                          }}
                          className="px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-lg flex items-center gap-1"
                        >
                          <XCircle className="w-3.5 h-3.5" /> 예약 취소
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* 예약 신청 모달 */}
      {showBookingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <h3 className="text-lg font-extrabold text-slate-900 mb-1">
              {currentMode === 'reading_room' ? `열람실 [${selectedSeat}] 예약` : '스터디룸 전체 대관 신청'}
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              {selectedDate} · {startTime} ~ {computedEndTime} (총 {durationSlots * 0.5}시간)
            </p>

            <form onSubmit={handleConfirmBooking} className="space-y-3.5">
              {currentMode === 'study_room' && (
                <>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" /> 동반자 학번 (10자리 숫자, 최소 1명 이상)
                    </label>
                    <input
                      type="text"
                      placeholder="예: 2026010123 (여러 명은 쉼표로 구분)"
                      value={companionIdsText}
                      onChange={(e) => setCompanionIdsText(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                    />
                    <p className="text-[11px] text-slate-400 mt-1">
                      - 대표자 포함 최소 2인 이상이며, 최소 1명은 정회원이어야 합니다.
                    </p>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">총 사용 인원</label>
                      <input
                        type="number"
                        min={2}
                        max={20}
                        value={totalHeadcount}
                        onChange={(e) => setTotalHeadcount(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs font-bold text-slate-700 mb-1">사용 목적</label>
                      <input
                        type="text"
                        placeholder="예: 전공 팀플, 스터디 회의"
                        value={purpose}
                        onChange={(e) => setPurpose(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1">
                  <Lock className="w-3.5 h-3.5" /> 일회성 예약 비밀번호 (숫자 4자리)
                </label>
                <input
                  type="password"
                  maxLength={4}
                  placeholder="숫자 4자리 (예: 1234)"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl tracking-widest"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  - 나중에 예약을 취소하거나 실시간 퇴실할 때 사용됩니다.
                </p>
              </div>

              {bookingError && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600">
                  {bookingError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBookingModal(false)}
                  className="px-4 py-2 text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl"
                >
                  닫기
                </button>
                <button
                  type="submit"
                  disabled={bookingSubmitting}
                  className="px-5 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
                >
                  {bookingSubmitting ? '처리 중...' : '최종 예약 확정'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 취소 / 실시간 퇴실 모달 */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900 mb-1">
              {actionModal.type === 'early_exit' ? '실시간 퇴실 (조기 종료)' : '예약 취소 확인'}
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              {actionModal.type === 'early_exit'
                ? '지금 퇴실하시면 현재 30분 단위 시간 이후의 잔여 시간이 즉시 빈자리로 반환됩니다.'
                : actionModal.reservation?.mode === 'reading_room'
                ? '예약 시 설정한 숫자 4자리 비밀번호를 입력해 주세요. (열람실 취소 시 동일 좌석 10분간 예약 제한)'
                : '예약 시 설정한 숫자 4자리 비밀번호를 입력해 주세요.'}
            </p>

            <form onSubmit={handleExecuteAction} className="space-y-3">
              <input
                type="password"
                maxLength={4}
                placeholder="일회성 비밀번호 4자리"
                value={actionPin}
                onChange={(e) => setActionPin(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-xl text-center tracking-widest"
              />

              {actionError && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600">
                  {actionError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  className="px-4 py-2 text-xs font-bold bg-slate-100 text-slate-700 rounded-xl"
                >
                  닫기
                </button>
                <button
                  type="submit"
                  disabled={actionSubmitting}
                  className="px-4 py-2 text-xs font-bold bg-slate-900 text-white rounded-xl"
                >
                  {actionSubmitting ? '확인 중...' : '확인'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}