package files

import (
	"image"
	"strings"
	"testing"
)

func TestSafeFilename(t *testing.T) {
	cases := map[string]string{
		"print.png":               "print.png",
		"../../etc/passwd":        "passwd",
		`C:\Users\ana\foto.jpg`:   "foto.jpg",
		"  ":                      "arquivo",
		"..":                      "arquivo",
		"a\"b\x00c.txt":           "abc.txt",
		"relatório final (1).pdf": "relatório final (1).pdf",
	}
	for in, want := range cases {
		if got := SafeFilename(in); got != want {
			t.Errorf("SafeFilename(%q) = %q, want %q", in, got, want)
		}
	}
	long := SafeFilename(strings.Repeat("x", 300) + ".png")
	if len([]rune(long)) != 120 || long[len(long)-4:] != ".png" {
		t.Errorf("nome longo não foi cortado mantendo a extensão: %d %q", len([]rune(long)), long[len(long)-8:])
	}
}

func TestKeyIsURLSafe(t *testing.T) {
	k := Key("1", "2", "abc", "print do jogo é top.png")
	if k != "attachments/1/2/abc/print_do_jogo___top.png" {
		t.Fatalf("chave inesperada: %q", k)
	}
}

func TestResizeKeepsAspect(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1920, 1080))
	thumb, w, h := Resize(img, 400, 300)
	if thumb == nil || w != 400 || h != 225 {
		t.Fatalf("esperava 400x225, veio %dx%d", w, h)
	}
	if small, _, _ := Resize(image.NewRGBA(image.Rect(0, 0, 200, 100)), 400, 300); small != nil {
		t.Fatal("imagem pequena não deveria ser redimensionada")
	}
	tall, w, h := Resize(image.NewRGBA(image.Rect(0, 0, 600, 3000)), 400, 300)
	if tall == nil || h != 300 || w != 60 {
		t.Fatalf("imagem alta: esperava 60x300, veio %dx%d", w, h)
	}
}
