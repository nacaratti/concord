// Package files guarda anexos num armazenamento compatível com S3 (RustFS em dev, R2/S3 em produção).
// O navegador envia o arquivo direto ao armazenamento por uma URL pré-assinada; o servidor só confere
// o resultado (tamanho e tipo reais, lidos do próprio arquivo) e gera a miniatura das imagens.
package files

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // registra os decodificadores
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/cors"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	MaxUpload      = 25 << 20 // 25 MB por arquivo
	MaxAttachments = 10
	thumbMaxW      = 400
	thumbMaxH      = 300
	maxPixels      = 50_000_000 // recusa "bombas" de descompressão: 50 MP é muito acima de qualquer print
)

type Config struct {
	Endpoint       string // onde o servidor fala com o S3 (ex.: localhost:9000 ou storage:9000)
	PublicEndpoint string // o host que o navegador usa (entra na assinatura da URL pré-assinada)
	AccessKey      string
	SecretKey      string
	Bucket         string
	Secure         bool
	// PublicURL é a base dos links dos arquivos, ex.: http://localhost:9000/concord
	PublicURL string
}

// Attachment é o que fica gravado em messages.attachments e vai para os clientes.
type Attachment struct {
	ID           string `json:"id"`
	Filename     string `json:"filename"`
	Size         int64  `json:"size"`
	ContentType  string `json:"content_type"`
	URL          string `json:"url"`
	ThumbnailURL string `json:"thumbnail_url,omitempty"`
	Width        int    `json:"width,omitempty"`
	Height       int    `json:"height,omitempty"`
}

type Storage struct {
	cfg     Config
	client  *minio.Client // operações do servidor
	presign *minio.Client // só assina URLs com o host público; nunca faz chamadas de rede
}

var ErrInvalid = errors.New("arquivo inválido")

func New(cfg Config) (*Storage, error) {
	creds := credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, "")
	client, err := minio.New(cfg.Endpoint, &minio.Options{Creds: creds, Secure: cfg.Secure, Region: "us-east-1"})
	if err != nil {
		return nil, err
	}
	presign, err := minio.New(cfg.PublicEndpoint, &minio.Options{Creds: creds, Secure: cfg.Secure, Region: "us-east-1"})
	if err != nil {
		return nil, err
	}
	return &Storage{cfg: cfg, client: client, presign: presign}, nil
}

// Setup cria o bucket, libera leitura pública só de attachments/ (os nomes têm partes aleatórias)
// e permite que o navegador faça PUT direto (CORS). A assinatura da URL é o que autoriza o envio.
func (s *Storage) Setup(ctx context.Context) error {
	ok, err := s.client.BucketExists(ctx, s.cfg.Bucket)
	if err != nil {
		return err
	}
	if !ok {
		if err := s.client.MakeBucket(ctx, s.cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			return err
		}
	}
	policy := fmt.Sprintf(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},`+
		`"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::%s/attachments/*"]}]}`, s.cfg.Bucket)
	if err := s.client.SetBucketPolicy(ctx, s.cfg.Bucket, policy); err != nil {
		return fmt.Errorf("política do bucket: %w", err)
	}
	rules := cors.NewConfig([]cors.Rule{{
		AllowedOrigin: []string{"*"},
		AllowedMethod: []string{"PUT", "GET", "HEAD"},
		AllowedHeader: []string{"*"},
		ExposeHeader:  []string{"ETag"},
		MaxAgeSeconds: 3600,
	}})
	if err := s.client.SetBucketCors(ctx, s.cfg.Bucket, rules); err != nil {
		return fmt.Errorf("cors do bucket: %w", err)
	}
	return nil
}

// SafeFilename tira caminhos e caracteres de controle do nome que o usuário mandou.
func SafeFilename(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '"' || r == '/' {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if name == "" || name == "." || name == ".." {
		name = "arquivo"
	}
	if r := []rune(name); len(r) > 120 {
		ext := path.Ext(name)
		name = string(r[:120-len([]rune(ext))]) + ext
	}
	return name
}

// Key monta o caminho do objeto. O pedaço aleatório impede adivinhar links de arquivos alheios.
// O nome entra só como "slug" ASCII (o nome real fica no anexo e no Content-Disposition), para a
// chave ser igual com ou sem escape de URL.
func Key(channelID, uploadID, random, filename string) string {
	return "attachments/" + channelID + "/" + uploadID + "/" + random + "/" + slug(filename)
}

func slug(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '-' || r == '_'):
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

func (s *Storage) PresignPut(ctx context.Context, key string) (string, error) {
	u, err := s.presign.PresignedPutObject(ctx, s.cfg.Bucket, key, 15*time.Minute)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *Storage) PublicURL(key string) string {
	return strings.TrimRight(s.cfg.PublicURL, "/") + "/" + key
}

func (s *Storage) Delete(ctx context.Context, key string) {
	_ = s.client.RemoveObject(ctx, s.cfg.Bucket, key, minio.RemoveObjectOptions{})
}

var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// Finalize confere o arquivo que o navegador enviou e devolve o anexo pronto. O tipo vem dos bytes
// do arquivo (não do que o cliente disse); imagens ganham dimensões e miniatura.
func (s *Storage) Finalize(ctx context.Context, id, key, filename string) (Attachment, error) {
	info, err := s.client.StatObject(ctx, s.cfg.Bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return Attachment{}, fmt.Errorf("%w: o envio não foi concluído", ErrInvalid)
	}
	if info.Size <= 0 || info.Size > MaxUpload {
		s.Delete(ctx, key)
		return Attachment{}, fmt.Errorf("%w: tamanho fora do limite de 25 MB", ErrInvalid)
	}
	obj, err := s.client.GetObject(ctx, s.cfg.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return Attachment{}, err
	}
	defer obj.Close()
	data, err := io.ReadAll(io.LimitReader(obj, MaxUpload+1))
	if err != nil {
		return Attachment{}, err
	}
	ctype := http.DetectContentType(data)
	if i := strings.IndexByte(ctype, ';'); i >= 0 {
		ctype = ctype[:i]
	}
	att := Attachment{ID: id, Filename: filename, Size: info.Size, ContentType: ctype, URL: s.PublicURL(key)}

	if imageTypes[ctype] {
		if err := s.thumbnail(ctx, key, data, &att); err != nil {
			s.Delete(ctx, key)
			return Attachment{}, err
		}
		return att, nil
	}
	// Não é imagem: regrava os cabeçalhos para o navegador baixar em vez de abrir. Um HTML enviado
	// como anexo nunca roda como página, nem mesmo no domínio do armazenamento.
	safeType := ctype
	if strings.HasPrefix(ctype, "text/") {
		safeType = "text/plain; charset=utf-8"
	}
	_, err = s.client.CopyObject(ctx,
		minio.CopyDestOptions{Bucket: s.cfg.Bucket, Object: key, ReplaceMetadata: true, UserMetadata: map[string]string{
			"Content-Type":        safeType,
			"Content-Disposition": `attachment; filename*=UTF-8''` + url.PathEscape(filename),
		}},
		minio.CopySrcOptions{Bucket: s.cfg.Bucket, Object: key})
	if err != nil {
		return Attachment{}, fmt.Errorf("cabeçalhos do anexo: %w", err)
	}
	att.ContentType = strings.TrimSuffix(safeType, "; charset=utf-8")
	return att, nil
}

func (s *Storage) thumbnail(ctx context.Context, key string, data []byte, att *Attachment) error {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("%w: imagem corrompida", ErrInvalid)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxPixels {
		return fmt.Errorf("%w: imagem grande demais", ErrInvalid)
	}
	att.Width, att.Height = cfg.Width, cfg.Height
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("%w: imagem corrompida", ErrInvalid)
	}
	thumb, _, _ := Resize(img, thumbMaxW, thumbMaxH)
	if thumb == nil {
		return nil // já é pequena: a própria imagem serve de miniatura
	}
	var buf bytes.Buffer
	ctype, ext := "image/jpeg", "jpg"
	if hasAlpha(img) {
		ctype, ext = "image/png", "png"
		err = png.Encode(&buf, thumb)
	} else {
		err = jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: 82})
	}
	if err != nil {
		return err
	}
	thumbKey := path.Dir(key) + "/thumb." + ext
	if _, err := s.client.PutObject(ctx, s.cfg.Bucket, thumbKey, &buf, int64(buf.Len()),
		minio.PutObjectOptions{ContentType: ctype, CacheControl: "public, max-age=31536000, immutable"}); err != nil {
		return err
	}
	att.ThumbnailURL = s.PublicURL(thumbKey)
	return nil
}

// Resize reduz a imagem para caber em maxW×maxH mantendo a proporção. Devolve nil se ela já cabe.
func Resize(img image.Image, maxW, maxH int) (image.Image, int, int) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxW && h <= maxH {
		return nil, w, h
	}
	scale := min(float64(maxW)/float64(w), float64(maxH)/float64(h))
	nw, nh := max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst, nw, nh
}

func hasAlpha(img image.Image) bool {
	if o, ok := img.(interface{ Opaque() bool }); ok {
		return !o.Opaque()
	}
	return true
}
