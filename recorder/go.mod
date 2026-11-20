module github.com/fazol/recorder

go 1.26

require github.com/livekit/server-sdk-go/v2 v2.20.0

// O SDK do LiveKit usa forks do pion; diretivas replace não são herdadas,
// então precisam ser repetidas aqui.
replace github.com/pion/webrtc/v4 => github.com/livekit/webrtc-pion/v4 v4.2.25-warp.3

replace github.com/pion/ice/v4 => github.com/livekit/ice/v4 v4.4.8-warp.4
