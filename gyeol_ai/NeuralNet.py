class NeuralNet():
    """alpha-zero-general 의 NeuralNet 인터페이스."""

    def __init__(self, game):
        pass

    def train(self, examples):
        """examples: [(board, pi, v)]"""
        raise NotImplementedError

    def predict(self, board):
        """(pi, v) 반환"""
        raise NotImplementedError

    def save_checkpoint(self, folder, filename):
        raise NotImplementedError

    def load_checkpoint(self, folder, filename):
        raise NotImplementedError
