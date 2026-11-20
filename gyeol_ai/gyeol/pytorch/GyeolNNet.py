import torch
import torch.nn as nn
import torch.nn.functional as F


def encode_boards(boards):
    """
    정규형 보드 (B, N, N) int8 → 입력 텐서 (B, 9, N, N)
      0~3 : 내 타일 (방향별)   4~7 : 상대 타일 (방향별)   8 : 빈 칸
    """
    b = boards.long()
    planes = []
    for owner in (1, -1):
        for d in range(4):
            planes.append((b == owner * (d + 1)).float())
    planes.append((b == 0).float())
    return torch.stack(planes, dim=1)


class ResBlock(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


class GyeolNNet(nn.Module):
    IN_PLANES = 9

    def __init__(self, game, args):
        super().__init__()
        self.n, _ = game.getBoardSize()
        self.action_size = game.getActionSize()
        ch = args.num_channels

        self.stem = nn.Sequential(
            nn.Conv2d(self.IN_PLANES, ch, 3, padding=1, bias=False),
            nn.BatchNorm2d(ch),
            nn.ReLU(),
        )
        self.tower = nn.Sequential(*[ResBlock(ch) for _ in range(args.num_res_blocks)])

        # 정책: 칸마다 64개(새 방향4 x 놓을 위치4 x 놓을 방향4) 로짓 + 패스 1개
        self.p_conv = nn.Conv2d(ch, 64, 1)
        self.p_pass = nn.Linear(ch, 1)

        self.v_conv = nn.Sequential(nn.Conv2d(ch, 4, 1, bias=False), nn.BatchNorm2d(4), nn.ReLU())
        self.v_fc1 = nn.Linear(4 * self.n * self.n, 128)
        self.v_fc2 = nn.Linear(128, 1)
        self.dropout = args.dropout

    def forward(self, boards):
        x = encode_boards(boards)
        x = self.tower(self.stem(x))

        p = self.p_conv(x)                               # (B, 64, n, n)
        p = p.permute(0, 2, 3, 1).reshape(x.size(0), -1)  # 칸 우선 → 액션 인덱스와 일치
        p_pass = self.p_pass(x.mean(dim=(2, 3)))
        pi = torch.cat([p, p_pass], dim=1)

        v = self.v_conv(x).flatten(1)
        v = F.dropout(F.relu(self.v_fc1(v)), p=self.dropout, training=self.training)
        v = torch.tanh(self.v_fc2(v))
        return F.log_softmax(pi, dim=1), v
