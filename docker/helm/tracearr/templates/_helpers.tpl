{{- define "tracearr.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tracearr.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "tracearr.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tracearr.labels" -}}
helm.sh/chart: {{ include "tracearr.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "tracearr.name" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{ include "tracearr.selectorLabels" . }}
{{- end }}

{{- define "tracearr.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tracearr.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "tracearr.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "tracearr.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "tracearr.secretName" -}}
{{- default (include "tracearr.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "tracearr.timescale.fullname" -}}
{{- printf "%s-timescale" (include "tracearr.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tracearr.timescale.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tracearr.name" . }}-timescale
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: database
{{- end }}

{{- define "tracearr.timescale.labels" -}}
helm.sh/chart: {{ include "tracearr.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "tracearr.name" . }}
{{ include "tracearr.timescale.selectorLabels" . }}
{{- end }}

{{- define "tracearr.redis.fullname" -}}
{{- printf "%s-redis" (include "tracearr.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tracearr.redis.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tracearr.name" . }}-redis
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: cache
{{- end }}

{{- define "tracearr.redis.labels" -}}
helm.sh/chart: {{ include "tracearr.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "tracearr.name" . }}
{{ include "tracearr.redis.selectorLabels" . }}
{{- end }}

{{/* DATABASE_URL with $(DB_PASSWORD) for k8s env var interpolation */}}
{{- define "tracearr.databaseUrl" -}}
{{- if .Values.timescale.enabled }}
{{- printf "postgres://tracearr:$(DB_PASSWORD)@%s:%v/tracearr" (include "tracearr.timescale.fullname" .) (.Values.timescale.service.port | int) }}
{{- else }}
{{- printf "postgres://%s:$(DB_PASSWORD)@%s:%v/%s" .Values.externalDatabase.user .Values.externalDatabase.host (.Values.externalDatabase.port | int) .Values.externalDatabase.database }}
{{- end }}
{{- end }}

{{- define "tracearr.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://%s:%v" (include "tracearr.redis.fullname" .) (.Values.redis.service.port | int) }}
{{- else }}
{{- .Values.externalRedis.url }}
{{- end }}
{{- end }}

{{- define "tracearr.image" -}}
{{- $tag := default .Chart.AppVersion .Values.tracearr.image.tag }}
{{- if or (hasPrefix "@" $tag) (contains "@sha256:" $tag) }}
{{- printf "%s%s" .Values.tracearr.image.repository $tag }}
{{- else }}
{{- printf "%s:%s" .Values.tracearr.image.repository $tag }}
{{- end }}
{{- end }}

{{/* The port the server binds to. containerPort, the Service targetPort and the
NetworkPolicy all read this, so tracearr.env.PORT is the only place to set it. */}}
{{- define "tracearr.containerPort" -}}
{{- index (.Values.tracearr.env | default dict) "PORT" | default 3000 | int -}}
{{- end }}
