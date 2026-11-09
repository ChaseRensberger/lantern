// A small local service for trying Lantern. It binds an OS-assigned loopback
// port, prints its address, and does not need external services or credentials.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
)

type Item struct {
	Name     string `json:"name"`
	Price    int    `json:"price"`
	Quantity int    `json:"quantity"`
}
type Order struct {
	Customer string `json:"customer"`
	Items    []Item `json:"items"`
	Discount int    `json:"discount"`
}

func total(order Order) int {
	subtotal := 0
	for _, item := range order.Items {
		subtotal += item.Price * item.Quantity // Try a breakpoint here.
	}
	return subtotal - order.Discount
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /order", func(w http.ResponseWriter, r *http.Request) {
		order := Order{Customer: "Ada", Items: []Item{{Name: "Notebook", Price: 1200, Quantity: 2}, {Name: "Pen", Price: 300, Quantity: 3}}, Discount: 500}
		amount := total(order)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"order": order, "total": amount})
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Orders service listening at http://%s/order\n", listener.Addr())
	log.Fatal(http.Serve(listener, mux))
}
