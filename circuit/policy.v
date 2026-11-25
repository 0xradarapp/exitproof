// ExitProof policy circuit. Combinational; mirrors circuit/spec.py.
module policy(
    input  [10:0] x,
    output [3:0]  y   // y[0]=allow, y[3:1]=reason
);
    wire sellOk = x[0];
    wire [1:0] st = x[2:1];
    wire [1:0] bt = x[4:3];
    wire owner = x[5], upg = x[6], dng = x[7], uns = x[8];
    wire [1:0] mode = x[10:9];
    wire strict = (mode == 2'd0) | (mode == 2'd3);
    wire bal    = (mode == 2'd1);
    wire perm   = (mode == 2'd2);

    wire stBad = strict ? (st != 2'd0) : (st >= 2'd2);
    wire btBad = strict ? (bt != 2'd0) : (bt >= 2'd2);

    wire r1 = ~sellOk;
    wire r2 = ~r1 & stBad;
    wire r3 = ~r1 & ~stBad & btBad;
    wire pass3 = ~r1 & ~stBad & ~btBad;
    wire r4 = pass3 & ~perm & upg;
    wire p4 = pass3 & ~(~perm & upg);
    wire r5 = p4 & ~perm & (strict ? dng : (owner & dng));
    wire p5 = p4 & ~r5;
    wire r6 = p5 & ~perm & (strict ? uns : (owner & uns));
    wire p6 = p5 & ~r6;
    wire r7 = p6 & strict & owner;
    wire allow = p6 & ~r7;

    wire [2:0] reason =
        r1 ? 3'd1 : r2 ? 3'd2 : r3 ? 3'd3 : r4 ? 3'd4 :
        r5 ? 3'd5 : r6 ? 3'd6 : r7 ? 3'd7 : 3'd0;
    assign y = {reason, allow};
endmodule
