FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /concord ./cmd/concord

FROM gcr.io/distroless/static-debian12
COPY --from=build /concord /concord
EXPOSE 8080
ENTRYPOINT ["/concord"]
