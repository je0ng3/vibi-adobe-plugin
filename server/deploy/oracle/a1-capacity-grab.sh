#!/usr/bin/env bash
# Oracle A1.Flex capacity hunter — plugin-api 전용 인스턴스를 "Out of capacity" 가 풀릴
# 때까지 AD 순회 재시도로 확보. vibi-bff 의 동명 스크립트를 그대로 본떴고, 다른 점은
# DISPLAY_NAME 과 shape 크기(OCPU/MEM)뿐.
#
# 무료 A1 쿼터는 테넌시당 4 OCPU / 24GB 총합. vibi-bff 가 이미 2 OCPU / 12GB 를 쓰므로
# 남은 무료 전량인 2 OCPU / 12GB 로 이 VM 을 띄운다 → 추가 비용 $0.
#
# 사용:
#   oci session authenticate --region us-ashburn-1 --profile-name vibi   # 1회 인증
#   OCI_PROFILE=vibi ./a1-capacity-grab.sh                               # 실행
#
# 잡히면 RUNNING 까지 기다렸다가 인스턴스 정보 출력하고 종료.
set -uo pipefail

PROFILE="${OCI_PROFILE:-vibi}"
AUTH="${OCI_AUTH:-security_token}"   # session authenticate 프로필이면 security_token
COMPARTMENT="ocid1.tenancy.oc1..aaaaaaaabn6767isuap76ouj73c4un5pkmp46wyyjx2skckohrlnap7t5jjq"
SUBNET="ocid1.subnet.oc1.iad.aaaaaaaazci3w5yt3zuyyzm22zbjdx76fxvqsehao7rrhm7mwxqt6zrmuufq"   # bff 와 같은 VCN public subnet
IMAGE="ocid1.image.oc1.iad.aaaaaaaas3q57pjdbmj46ykc5djtazakxanfvvadw43iuyguiue6ruvjd6yq"     # Canonical-Ubuntu-22.04-aarch64-2026.04.30-1
SHAPE="VM.Standard.A1.Flex"
OCPUS="${OCPUS:-2}"                  # 남은 무료 전량 (bff 가 2/12 사용 중)
MEM="${MEM:-12}"
DISPLAY_NAME="vibi-plugin-api"
SSH_KEY_FILE="$HOME/.ssh/id_ed25519.pub"
SLEEP="${SLEEP:-60}"

# AD 목록 (oci iam availability-domain list 로 확인된 us-ashburn-1 의 3개)
ADS=("OUat:US-ASHBURN-AD-1" "OUat:US-ASHBURN-AD-2" "OUat:US-ASHBURN-AD-3")
echo "AD 목록: ${ADS[*]}"

attempt=0
while true; do
  for AD in "${ADS[@]}"; do
    attempt=$((attempt+1))
    # 토큰 1시간 만료 방지 — 12회(≈30분)마다 갱신 (session token 프로필일 때만)
    if [ "$AUTH" = "security_token" ] && [ $((attempt % 12)) -eq 1 ] && [ "$attempt" -gt 1 ]; then
      oci session refresh --profile "$PROFILE" >/dev/null 2>&1 && echo "  ↻ 토큰 refresh" || echo "  ⚠️ refresh 실패"
    fi
    printf '[%s] #%d  AD=%s … ' "$(date '+%H:%M:%S')" "$attempt" "$AD"
    OUT=$(oci compute instance launch \
      --profile "$PROFILE" --auth "$AUTH" \
      --availability-domain "$AD" \
      --compartment-id "$COMPARTMENT" \
      --shape "$SHAPE" \
      --shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEM}" \
      --subnet-id "$SUBNET" \
      --assign-public-ip true \
      --image-id "$IMAGE" \
      --display-name "$DISPLAY_NAME" \
      --ssh-authorized-keys-file "$SSH_KEY_FILE" \
      --wait-for-state RUNNING 2>&1)
    RC=$?
    if [ $RC -eq 0 ]; then
      echo "✅ SUCCESS"
      echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('instance:', d['id']); print('state:', d['lifecycle-state'])" 2>/dev/null || echo "$OUT"
      echo "→ 공인 IP 확인: oci compute instance list-vnics --instance-id <id> --profile $PROFILE --auth $AUTH --query 'data[0].\"public-ip\"' --raw-output"
      exit 0
    fi
    if echo "$OUT" | grep -qiE "out of (host )?capacity|capacity|too ?many ?requests|429|InternalError|500"; then
      echo "재시도(capacity/throttle)"
    elif echo "$OUT" | grep -qiE "NotAuthenticated|NotAuthorizedOrNotFound|401|404|400|expired"; then
      echo "❌ 인증/설정 에러 — 중단:"
      echo "$OUT" | head -15
      exit 1
    else
      echo "알수없는 에러(계속 재시도):"
      echo "$OUT" | head -8
    fi
  done
  sleep "$SLEEP"
done
